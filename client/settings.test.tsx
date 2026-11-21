import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSchema } from "../shared/settings";
import { ReviewSettings } from "./settings";

const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: ({ name }: { name: string }) => {
    if (name === "reviews.settings.read") return rpc.read;
    if (name === "reviews.settings.write") return rpc.write;
    throw new Error(`Unexpected RPC: ${name}`);
  },
}));

// The settings kit is supplied by the host at runtime; stand in plain elements.
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: "settings-action",
  SettingsCard: "settings-card",
  SettingsInput: "settings-input",
  SettingsRow: "settings-row",
  SettingsSection: "settings-section",
}));

vi.mock("react-native", () => ({
  Modal: "modal",
  Pressable: "pressable",
  ScrollView: "scroll-view",
  Text: "text",
  View: "view",
  useWindowDimensions: () => ({ width: 640, height: 480 }),
}));

const props: PluginSurfaceProps = {
  host: { id: "local", label: "Local" },
  layout: { compact: false, platform: "web" },
  theme: {
    colors: {
      surface0: "#111111",
      surface1: "#222222",
      surface2: "#333333",
      border: "#444444",
      foreground: "#eeeeee",
      foregroundMuted: "#aaaaaa",
      accent: "#0088ff",
      accentForeground: "#ffffff",
      statusSuccess: "#00ff00",
      statusWarning: "#ffff00",
      statusDanger: "#ff0000",
    },
  },
};

const loaded = {
  status: "ready",
  path: "/home/me/.paseo/plugin-state/paseo-review/settings.json",
  revision: "r1",
  values: SettingsSchema.parse({ include: { repositories: ["acme/api"] } }),
};

describe("review settings editor", () => {
  let renderer: ReactTestRenderer;
  let client: QueryClient;

  beforeAll(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Deliver query results inside the awaited act() rather than a later timer.
    notifyManager.setScheduler(queueMicrotask);
  });

  afterAll(() => {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    rpc.read.mockResolvedValue(loaded);
    client = new QueryClient();
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <ReviewSettings {...props} />
        </QueryClientProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => renderer.unmount());
    client.clear();
  });

  function input(label: string, index = 0): ReactTestInstance {
    return renderer.root.findAll(
      (node) => (node.type as unknown) === "settings-input" && node.props.label === label,
    )[index]!;
  }

  function action(actionLabel: string): ReactTestInstance {
    return renderer.root.findAll(
      (node) => (node.type as unknown) === "settings-action" && node.props.actionLabel === actionLabel,
    )[0]!;
  }

  async function type(target: ReactTestInstance, text: string) {
    await act(async () => target.props.onChangeText(text));
  }

  it("saves typed entries and converted units against the loaded revision", async () => {
    expect(action("Save").props.disabled).toBe(true);
    // Typed but never added with the Add button: Save must not drop it.
    await type(input("Repositories"), "acme/web, ACME/api");
    await type(input("Refresh interval (seconds)"), "90");
    await type(input("Cache size (MB)"), "1.5");
    rpc.write.mockResolvedValue({
      status: "saved",
      revision: "r2",
      values: SettingsSchema.parse({ include: { repositories: ["acme/api", "acme/web"] } }),
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => action("Save").props.onPress());

    expect(rpc.write).toHaveBeenCalledExactlyOnceWith({
      revision: "r1",
      values: expect.objectContaining({
        include: expect.objectContaining({ repositories: ["acme/api", "acme/web"] }),
        refreshIntervalMs: 90_000,
        cacheMaxBytes: 1_572_864,
      }),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["reviews"] });
    // The editor reopens from the saved revision with nothing pending.
    expect(action("Save").props.disabled).toBe(true);
    expect(rpc.read).toHaveBeenCalledOnce();
  });

  it("blocks saving until an invalid field is fixed", async () => {
    await type(input("Updated within"), "soon");
    expect(input("Updated within").props.error).toMatch(/number followed by h, d, or w/);
    expect(action("Save").props.disabled).toBe(true);

    await type(input("Parallel detail fetches"), "two");
    expect(input("Parallel detail fetches").props.error).toBe("Enter a number");

    await type(input("Updated within"), "2w");
    await type(input("Parallel detail fetches"), "2");
    expect(action("Save").props.disabled).toBe(false);
  });

  it("keeps the draft and offers a reload when the file changed underneath it", async () => {
    await type(input("Bot reviewers"), "lpu-review-approver");
    rpc.write.mockResolvedValue({ status: "conflict", error: "Settings changed elsewhere." });

    await act(async () => action("Save").props.onPress());

    expect(action("Save").props.error).toBe("Settings changed elsewhere.");
    expect(action("Save").props.disabled).toBe(false);
    rpc.read.mockResolvedValue({ ...loaded, revision: "r3" });
    await act(async () => action("Reload").props.onPress());
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(action("Save").props.disabled).toBe(true);
  });
});
