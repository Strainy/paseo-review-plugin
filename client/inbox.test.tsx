import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestSchema, type ReviewListResult } from "../shared/reviews";
import { ActionButton, ReviewDetail, ReviewFilterChip, ReviewQueueRow } from "./card";
import { ReviewInbox } from "./inbox";

const rpc = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  progress: vi.fn(),
  unread: vi.fn(),
  approve: vi.fn(),
  map: vi.fn(),
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useHosts: () => [{ serverId: "local", label: "Local", status: "online" }],
  useRpc: ({ name }: { name: string }) => {
    switch (name) {
      case "reviews.list": return rpc.list;
      case "reviews.detail": return rpc.detail;
      case "reviews.progress": return rpc.progress;
      case "reviews.unread.set": return rpc.unread;
      case "reviews.approve": return rpc.approve;
      case "reviews.repositories.map": return rpc.map;
      default: throw new Error(`Unexpected RPC: ${name}`);
    }
  },
  getPaseoClient: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "view",
  Text: "text",
  ScrollView: "scroll-view",
}));

// Keep the inbox, its callbacks, and React Query live; replace only native visuals.
vi.mock("./card", () => ({
  ActionButton: "action-button",
  ReviewDetail: "review-detail",
  ReviewEmptyDetail: "review-empty-detail",
  ReviewFilterChip: "review-filter-chip",
  ReviewQueueRow: "review-queue-row",
}));

vi.mock("./use-projects", () => ({
  useReviewProjects: () => ({ projects: [], status: null }),
}));

const screenProps: PluginScreenProps = {
  host: { id: "local", label: "Local" },
  layout: { compact: false, platform: "web" },
  params: {},
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

function snapshot(count: number): ReviewListResult {
  return {
    pullRequests: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      return PullRequestSchema.parse({
        id: `acme/api#${number}`,
        repository: "acme/api",
        number,
        title: `Review ${number}`,
        url: `https://github.com/acme/api/pull/${number}`,
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
        unread: true,
      });
    }),
    viewer: "kim",
    stale: false,
    error: null,
    fetchedAt: "2026-10-01T00:00:00Z",
    agentProvider: "claude",
    refreshIntervalMs: 120_000,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("review inbox interactions", () => {
  let renderer: ReactTestRenderer;
  let client: QueryClient;
  let server: ReviewListResult;

  beforeAll(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    notifyManager.setScheduler(queueMicrotask);
  });

  afterAll(() => {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rpc.list.mockImplementation(async () => server);
    rpc.progress.mockResolvedValue({ phase: "idle", detail: "", current: 0, total: 0, history: [] });
    rpc.detail.mockImplementation(async ({ id }: { id: string }) => ({
      id, body: "", diff: "", diffTruncated: false, additions: 0, deletions: 0, changedFiles: 0,
    }));
    rpc.unread.mockImplementation(async (input: { id: string; unread: boolean }) => {
      server = {
        ...server,
        pullRequests: server.pullRequests.map((pr) =>
          pr.id === input.id ? { ...pr, unread: input.unread } : pr,
        ),
      };
      return input;
    });
    rpc.approve.mockImplementation(async ({ id }: { id: string }) => {
      server = { ...server, pullRequests: server.pullRequests.filter((pr) => pr.id !== id) };
      return { approved: true };
    });
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    client.clear();
  });

  async function mount(count: number) {
    server = snapshot(count);
    client.setQueryData(["reviews"], server);
    client.setQueryData(["reviews", "cached"], server);
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <ReviewInbox {...screenProps} />
        </QueryClientProvider>,
      );
    });
  }

  function rows() {
    return renderer.root.findAllByType(ReviewQueueRow);
  }

  async function select(id: string) {
    await act(async () => {
      rows().find((row) => row.props.pullRequest.id === id)!.props.onSelect(id);
    });
  }

  it("keeps the next PR selected and visible when an earlier approval finishes", async () => {
    const approval = deferred<{ approved: boolean }>();
    rpc.approve.mockImplementationOnce(async ({ id }: { id: string }) => {
      const result = await approval.promise;
      server = { ...server, pullRequests: server.pullRequests.filter((pr) => pr.id !== id) };
      return result;
    });
    await mount(2);
    await select("acme/api#1");
    await act(async () => renderer.root.findByType(ReviewDetail).props.onApprove());
    await select("acme/api#2");
    expect(renderer.root.findByType(ReviewDetail).props.pullRequest.id).toBe("acme/api#2");

    await act(async () => approval.resolve({ approved: true }));

    expect(rpc.list).toHaveBeenCalled();
    expect(renderer.root.findByType(ReviewDetail).props.pullRequest.id).toBe("acme/api#2");
    expect(rows().map((row) => row.props.pullRequest.id)).toEqual(["acme/api#2"]);
    expect(rows()[0].props.selected).toBe(true);
    expect(rpc.approve).toHaveBeenCalledExactlyOnceWith({ id: "acme/api#1" });
    expect(rpc.unread.mock.calls).toEqual([
      [{ id: "acme/api#1", unread: false }],
      [{ id: "acme/api#2", unread: false }],
    ]);
  });

  it("empties the queue and detail after approving its last PR", async () => {
    await mount(1);
    await select("acme/api#1");
    expect(rows()).toHaveLength(1);
    await act(async () => renderer.root.findByType(ReviewDetail).props.onApprove());

    expect(rpc.list).toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    expect(renderer.root.findAllByType(ReviewDetail)).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("No unread reviews");
    expect(client.getQueryData<ReviewListResult>(["reviews"])?.pullRequests).toEqual([]);
  });

  it("marks the whole queue read, including clearing the selected read row", async () => {
    await mount(3);
    await select("acme/api#1");
    rpc.unread.mockClear();
    const markAll = renderer.root.findAllByType(ActionButton)
      .find((button) => button.props.label === "Mark all as Read")!;
    expect(markAll.props.disabled).toBeFalsy();
    await act(async () => markAll.props.onPress());

    expect(rpc.unread.mock.calls.map(([input]) => input)).toEqual([
      { id: "acme/api#2", unread: false },
      { id: "acme/api#3", unread: false },
    ]);
    expect(rows()).toHaveLength(0);
    expect(renderer.root.findAllByType(ReviewDetail)).toHaveLength(0);
    for (const key of [["reviews"], ["reviews", "cached"]]) {
      expect(client.getQueryData<ReviewListResult>(key)?.pullRequests.every((pr) => !pr.unread)).toBe(true);
    }

    await act(async () => {
      renderer.root.findAllByType(ReviewFilterChip)
        .find((chip) => chip.props.filter === "all")!.props.onSelect("all");
    });
    expect(rows()).toHaveLength(3);
  });

  it("can clear the last selected row after opening it has marked it read", async () => {
    await mount(1);
    await select("acme/api#1");
    const markAll = renderer.root.findAllByType(ActionButton)
      .find((button) => button.props.label === "Mark all as Read")!;
    expect(markAll.props.disabled).toBeFalsy();
    await act(async () => markAll.props.onPress());

    expect(rows()).toHaveLength(0);
    expect(renderer.root.findAllByType(ReviewDetail)).toHaveLength(0);
  });

  it("keeps the queue cleared when a refresh started during mark-all resolves late", async () => {
    await mount(2);
    const beforeMarkAll = server;
    const unreadSave = deferred<void>();
    const refresh = deferred<ReviewListResult>();
    const saveUnread = rpc.unread.getMockImplementation()!;
    rpc.unread.mockImplementation(async (input: { id: string; unread: boolean }) => {
      await unreadSave.promise;
      return saveUnread(input);
    });
    rpc.list.mockReturnValueOnce(refresh.promise);

    await act(async () => {
      void renderer.root.findAllByType(ActionButton)
        .find((button) => button.props.label === "Mark all as Read")!.props.onPress();
    });
    expect(rpc.unread).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(0);

    await act(async () => {
      renderer.root.findAllByType(ActionButton)
        .find((button) => button.props.label === "Refresh")!.props.onPress();
    });
    expect(rpc.list).toHaveBeenCalledTimes(1);
    await act(async () => unreadSave.resolve());
    await act(async () => refresh.resolve(beforeMarkAll));

    expect(rows()).toHaveLength(0);
    for (const key of [["reviews"], ["reviews", "cached"]]) {
      expect(client.getQueryData<ReviewListResult>(key)?.pullRequests.map((pr) => pr.unread))
        .toEqual([false, false]);
    }
  });

  it("marks a different row unread without changing the selection", async () => {
    await mount(2);
    await select("acme/api#1");
    await select("acme/api#2");
    await act(async () => {
      renderer.root.findAllByType(ReviewFilterChip)
        .find((chip) => chip.props.filter === "all")!.props.onSelect("all");
    });
    rpc.unread.mockClear();
    await act(async () => {
      rows().find((row) => row.props.pullRequest.id === "acme/api#1")!
        .props.onMarkUnread("acme/api#1");
    });

    expect(rpc.unread).toHaveBeenCalledExactlyOnceWith({ id: "acme/api#1", unread: true });
    expect(renderer.root.findByType(ReviewDetail).props.pullRequest.id).toBe("acme/api#2");
    expect(rows().find((row) => row.props.pullRequest.id === "acme/api#1")!.props.pullRequest.unread).toBe(true);
    expect(rows().find((row) => row.props.pullRequest.id === "acme/api#2")!.props.selected).toBe(true);
  });

  it("keeps failed bulk updates unread while retaining successful updates", async () => {
    await mount(2);
    rpc.unread.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () => {
      await renderer.root.findAllByType(ActionButton)
        .find((button) => button.props.label === "Mark all as Read")!.props.onPress();
    });

    expect(rpc.unread).toHaveBeenCalledTimes(2);
    expect(rows().map((row) => row.props.pullRequest.id)).toEqual(["acme/api#1"]);
    for (const key of [["reviews"], ["reviews", "cached"]]) {
      expect(client.getQueryData<ReviewListResult>(key)?.pullRequests.map((pr) => pr.unread))
        .toEqual([true, false]);
    }
    expect(JSON.stringify(renderer.toJSON())).toContain("Could not mark 1 review as read");
    expect(JSON.stringify(renderer.toJSON())).toContain("Connection lost");
  });
});
