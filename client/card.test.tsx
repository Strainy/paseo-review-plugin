import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Modal } from "react-native";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestSchema } from "../shared/reviews";
import { ReviewQueueRow } from "./card";
import { createStyles } from "./theme";

vi.mock("react-native", () => ({
  Modal: "modal",
  Pressable: "pressable",
  ScrollView: "scroll-view",
  Text: "text",
  View: "view",
  useWindowDimensions: () => ({ width: 640, height: 480 }),
}));

const styles = createStyles({
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
}, false);

// Propagate through native ancestors to catch menu controls accidentally nested
// in the row's selection button. The real Pressables handle disabled inputs.
async function press(target: ReactTestInstance) {
  if (target.props.disabled) return;
  await act(async () => {
    let stopped = false;
    const event = { stopPropagation: () => { stopped = true; } };
    for (let node: ReactTestInstance | null = target; node && !stopped; node = node.parent) {
      if (typeof node.type === "string") node.props.onPress?.(event);
    }
  });
}

describe("review row actions", () => {
  let renderer: ReactTestRenderer;
  let triggerY: number;
  const onSelect = vi.fn();
  const onMarkUnread = vi.fn();
  const focusItem = vi.fn();

  beforeAll(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    triggerY = 150;
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
  });

  async function mount({ unread = false, unreadDisabled = false } = {}) {
    const pullRequest = PullRequestSchema.parse({
      id: "acme/api#1",
      repository: "acme/api",
      number: 1,
      title: "Review request",
      url: "https://github.com/acme/api/pull/1",
      author: "kim",
      isDraft: false,
      state: "open",
      merged: false,
      autoMerge: false,
      headSha: "abc123",
      requestedTeams: [],
      updatedAt: "2026-10-01T00:00:00Z",
      reviewState: "unreviewed",
      repositoryPath: null,
      unread,
    });
    await act(async () => {
      renderer = create(
        <ReviewQueueRow
          pullRequest={pullRequest}
          selected={false}
          now={Date.parse("2026-10-01T00:00:00Z")}
          onSelect={onSelect}
          onMarkUnread={onMarkUnread}
          unreadDisabled={unreadDisabled}
          styles={styles}
        />,
        {
          createNodeMock: (element) => ({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
              callback(400, triggerY, 30, 30),
            focus: (element.props as { accessibilityRole?: string }).accessibilityRole === "menuitem"
              ? focusItem : vi.fn(),
          }),
        },
      );
    });
  }

  function trigger() {
    return renderer.root.findByProps({ accessibilityLabel: "Actions for acme/api pull request 1" });
  }

  function menuItem() {
    return renderer.root.findByProps({ accessibilityRole: "menuitem" });
  }

  it("opens the menu and marks a PR unread without selecting it", async () => {
    await mount();
    await press(trigger());
    expect(trigger().props.accessibilityState.expanded).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => renderer.root.findByType(Modal).props.onShow());
    expect(focusItem).toHaveBeenCalledOnce();
    expect(menuItem().props.accessibilityLabel).toBe("Mark unread");
    await press(menuItem());

    expect(onMarkUnread).toHaveBeenCalledExactlyOnceWith("acme/api#1");
    expect(onSelect).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    expect(trigger().props.accessibilityState.expanded).toBe(false);
  });

  it.each([{ unread: true }, { unreadDisabled: true }])(
    "disables marking unread when %j",
    async (options) => {
      await mount(options);
      await press(trigger());
      expect(menuItem().props.disabled).toBe(true);
      expect(menuItem().props.accessibilityState.disabled).toBe(true);
      await act(async () => renderer.root.findByType(Modal).props.onShow());
      await press(menuItem());

      expect(focusItem).not.toHaveBeenCalled();
      expect(onMarkUnread).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it.each(["outside press", "request close", "accessibility escape"])(
    "dismisses on %s without changing the PR",
    async (method) => {
      await mount();
      await press(trigger());
      if (method === "outside press") {
        await press(renderer.root.findByProps({ accessibilityLabel: "Dismiss review actions" }));
      } else if (method === "request close") {
        await act(async () => renderer.root.findByType(Modal).props.onRequestClose());
      } else {
        await act(async () => {
          renderer.root.findByProps({ accessibilityRole: "menu" }).props.onAccessibilityEscape();
        });
      }

      expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
      expect(trigger().props.accessibilityState.expanded).toBe(false);
      expect(onMarkUnread).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("opens above a trigger near the bottom so the menu remains on screen", async () => {
    triggerY = 450;
    await mount();
    await press(trigger());
    const menu = renderer.root.findByProps({ accessibilityRole: "menu" });
    const position = Object.assign({}, ...menu.props.style);
    expect(position.top).toBeGreaterThanOrEqual(0);
    expect(position.top + 44).toBeLessThan(triggerY);
    expect(position.left).toBeGreaterThanOrEqual(0);
    expect(position.left + position.width).toBeLessThanOrEqual(640);
  });
});
