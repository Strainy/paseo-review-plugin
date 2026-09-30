import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeAge, describeProgress, progressFraction } from "../shared/progress";
import type { RefreshEvent } from "../shared/reviews";

vi.mock("./github", () => ({
  GitHubError: class GitHubError extends Error {
    secondaryRateLimited = false;
  },
  activeViewerLogin: vi.fn(async () => "kim"),
  listReviewNotifications: vi.fn(async () => [
    {
      id: "1",
      reason: "review_requested",
      updated_at: "2026-08-26T10:00:00Z",
      subject: {
        title: "One",
        url: "https://api.github.com/repos/acme/api/pulls/1",
        type: "PullRequest",
      },
      repository: { full_name: "acme/api" },
    },
    {
      id: "2",
      reason: "review_requested",
      updated_at: "2026-08-26T11:00:00Z",
      subject: {
        title: "Two",
        url: "https://api.github.com/repos/acme/api/pulls/2",
        type: "PullRequest",
      },
      repository: { full_name: "acme/api" },
    },
  ]),
  pullRequestEndpoint: (thread: {
    subject: { url: string };
    repository: { full_name: string };
  }) => {
    const number = Number(thread.subject.url.split("/").pop());
    return {
      id: `${thread.repository.full_name}#${number}`,
      endpoint: `repos/${thread.repository.full_name}/pulls/${number}`,
      repository: thread.repository.full_name,
      number,
    };
  },
  fetchPullRequest: vi.fn(async (endpoint: string) => {
    const number = Number(endpoint.split("/").pop());
    return {
      number,
      title: `PR ${number}`,
      body: null,
      html_url: `https://github.com/acme/api/pull/${number}`,
      user: { login: "someone" },
      draft: false,
      state: "open",
      merged_at: null,
      auto_merge: null,
      head: { sha: "abc123" },
      requested_teams: [],
      updated_at: `2026-08-26T${number === 1 ? "10" : number === 2 ? "11" : "12"}:00:00Z`,
    };
  }),
  fetchReviews: vi.fn(async () => []),
  submitApproval: vi.fn(async () => undefined),
}));

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "paseo-review-progress-"));
  process.env.PASEO_HOME = home;
  vi.resetModules();
  // Mock instances survive resetModules, so call counts leak between tests.
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.PASEO_HOME;
});

async function writeSettings(settings: object): Promise<void> {
  const directory = path.join(home, "plugin-state", "paseo-review");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "settings.json"), JSON.stringify(settings), "utf8");
}

describe("refresh progress", () => {
  it("walks the phases in order and counts PR details as it goes", async () => {
    const { list, readRefreshProgress } = await import("./reviews");

    await list({});
    const { history, phase } = readRefreshProgress();

    // Deduped run of phases, so repeated detail lines within a phase collapse.
    const phases = history
      .map((entry) => entry.phase)
      .filter((value, index, all) => value !== all[index - 1]);
    expect(phases).toEqual(["polling", "filtering", "identifying", "details", "done"]);
    expect(phase).toBe("done");

    // Details run in a pool, so the counter is completions rather than a serial
    // index: it must never go backwards and must finish at the total.
    const counted = history.filter((entry) => entry.phase === "details" && entry.total === 2);
    const counts = counted.map((entry) => entry.current);
    expect(counts[0]).toBe(0);
    expect(counts.at(-1)).toBe(2);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it("keeps the log bounded and starts a fresh one each refresh", async () => {
    const { list, readRefreshProgress } = await import("./reviews");

    await list({});
    const first = readRefreshProgress().history;
    await list({});
    const second = readRefreshProgress().history;

    expect(first.some((entry) => entry.detail.includes("acme/api#"))).toBe(true);
    expect(second.some((entry) => entry.detail.includes("acme/api#"))).toBe(false);
    expect(second.length).toBeLessThanOrEqual(50);
    expect(second[0]?.phase).toBe("polling");
  });

  it("shares one in-flight refresh between callers", async () => {
    const { list } = await import("./reviews");
    const github = await import("./github");

    const [first, second] = await Promise.all([list({}), list({})]);

    expect(github.listReviewNotifications).toHaveBeenCalledTimes(1);
    expect(first.pullRequests).toEqual(second.pullRequests);
  });

  it("keeps a read PR read after an update while sorting the queue by latest update", async () => {
    const { list, setUnread } = await import("./reviews");
    const github = await import("./github");

    await list({});
    await setUnread({ id: "acme/api#1", unread: false });
    vi.mocked(github.listReviewNotifications).mockResolvedValueOnce([
      {
        id: "1",
        reason: "review_requested",
        updated_at: "2026-08-26T13:00:00Z",
        subject: {
          title: "One",
          url: "https://api.github.com/repos/acme/api/pulls/1",
          type: "PullRequest",
        },
        repository: { full_name: "acme/api" },
      },
      {
        id: "2",
        reason: "review_requested",
        updated_at: "2026-08-26T11:00:00Z",
        subject: {
          title: "Two",
          url: "https://api.github.com/repos/acme/api/pulls/2",
          type: "PullRequest",
        },
        repository: { full_name: "acme/api" },
      },
    ]);
    vi.mocked(github.fetchPullRequest).mockResolvedValueOnce({
      number: 1,
      title: "PR 1 updated",
      body: null,
      html_url: "https://github.com/acme/api/pull/1",
      user: { login: "someone" },
      draft: false,
      state: "open",
      merged_at: null,
      auto_merge: null,
      head: { sha: "def456" },
      requested_teams: [],
      updated_at: "2026-08-26T13:00:00Z",
    });

    const result = await list({});

    expect(
      result.pullRequests.map(({ id, unread, updatedAt }) => ({ id, unread, updatedAt })),
    ).toEqual([
      { id: "acme/api#1", unread: false, updatedAt: "2026-08-26T13:00:00Z" },
      { id: "acme/api#2", unread: true, updatedAt: "2026-08-26T11:00:00Z" },
    ]);
  });

  it("caps actual detail requests without starving cached notification threads", async () => {
    await writeSettings({ include: {}, exclude: {}, maxDetailFetches: 1 });
    const { list } = await import("./reviews");
    const github = await import("./github");

    const first = await list({});

    expect(first.error).toBeNull();
    expect(first.pullRequests.map((pullRequest) => pullRequest.id)).toEqual(["acme/api#2"]);
    expect(github.fetchPullRequest).toHaveBeenCalledTimes(1);

    const second = await list({});

    expect(second.error).toBeNull();
    expect(second.pullRequests.map((pullRequest) => pullRequest.id)).toEqual([
      "acme/api#2",
      "acme/api#1",
    ]);
    expect(github.fetchPullRequest).toHaveBeenCalledTimes(2);
  });

  it("cancels in-flight GitHub work when the plugin is stopped", async () => {
    const github = await import("./github");
    const seen: { signal: AbortSignal | null } = { signal: null };
    let release: (() => void) | null = null;
    vi.mocked(github.listReviewNotifications).mockImplementationOnce(
      (_since, signal) =>
        new Promise((_resolve, reject) => {
          seen.signal = signal;
          release = () => reject(new Error("Cancelled"));
          function releaseOnAbort() {
            release?.();
          }
          signal.addEventListener("abort", releaseOnAbort, { once: true });
        }),
    );
    const { list, stopReviews } = await import("./reviews");

    const running = list({});
    // runList reads settings and the cache before it reaches GitHub.
    await vi.waitFor(() => expect(seen.signal).not.toBeNull());
    expect(seen.signal?.aborted).toBe(false);

    stopReviews();

    // The signal handed to gh aborts, so execFile kills the child instead of
    // running out its 45s attempt timeout after the host closed the channel.
    expect(seen.signal?.aborted).toBe(true);
    // The poll failure path still answers from cache rather than rejecting.
    await expect(running).resolves.toMatchObject({ stale: true });
  });

  it("refuses to start new work once stopping", async () => {
    const { list, stopReviews } = await import("./reviews");
    stopReviews();
    await expect(list({})).rejects.toThrow(/stopping/);
  });

  it("reports a failed poll as done rather than leaving a phase mid-flight", async () => {
    const github = await import("./github");
    vi.mocked(github.listReviewNotifications).mockRejectedValueOnce(new Error("offline"));
    const { list, readRefreshProgress } = await import("./reviews");

    const result = await list({});

    expect(result.stale).toBe(true);
    expect(result.error).toBe("offline");
    expect(readRefreshProgress().phase).toBe("done");
  });
});

describe("cached reads", () => {
  it("answers from disk without touching gh, so a reload is never blank", async () => {
    const github = await import("./github");
    const { list } = await import("./reviews");

    // Warm the on-disk cache with a real poll, then read it back.
    await list({});
    vi.clearAllMocks();
    const cachedResult = await list({ cachedOnly: true });

    expect(github.listReviewNotifications).not.toHaveBeenCalled();
    expect(github.fetchPullRequest).not.toHaveBeenCalled();
    expect(github.activeViewerLogin).not.toHaveBeenCalled();
    expect(cachedResult.stale).toBe(true);
    expect(cachedResult.pullRequests.map((pr) => pr.id)).toEqual(["acme/api#2", "acme/api#1"]);
  });

  it("does not take part in the single-flight shared with the live poll", async () => {
    const github = await import("./github");
    const { list } = await import("./reviews");

    const [live, fromCache] = await Promise.all([list({}), list({ cachedOnly: true })]);

    expect(github.listReviewNotifications).toHaveBeenCalledTimes(1);
    expect(live.stale).toBe(false);
    expect(fromCache.stale).toBe(true);
  });
});

describe("describeProgress", () => {
  const base: RefreshEvent = { phase: "idle", detail: "", current: 0, total: 0 };

  it("says nothing when idle or finished", () => {
    expect(describeProgress(base)).toBeNull();
    expect(describeProgress({ ...base, phase: "done", detail: "3 awaiting" })).toBeNull();
    expect(describeProgress(undefined)).toBeNull();
  });

  it("names the phase and what it is working on", () => {
    expect(describeProgress({ ...base, phase: "polling", detail: "" })).toBe(
      "Polling notifications",
    );
    expect(describeProgress({ ...base, phase: "filtering", detail: "42 threads received" })).toBe(
      "Filtering — 42 threads received",
    );
    expect(describeProgress({ ...base, phase: "identifying", detail: "Active account @kim" })).toBe(
      "Identifying reviewer — Active account @kim",
    );
  });

  it("counts PR details the way the TUI did", () => {
    expect(
      describeProgress({ phase: "details", detail: "acme/api#42", current: 3, total: 17 }),
    ).toBe("Loading PR details 3/17 — acme/api#42");
    expect(describeProgress({ phase: "details", detail: "", current: 3, total: 17 })).toBe(
      "Loading PR details 3/17",
    );
  });
});

describe("progressFraction", () => {
  it("only reports a fraction for countable work", () => {
    expect(progressFraction({ phase: "details", detail: "", current: 5, total: 10 })).toBe(0.5);
    expect(progressFraction({ phase: "polling", detail: "", current: 0, total: 0 })).toBeNull();
    expect(progressFraction({ phase: "details", detail: "", current: 1, total: 0 })).toBeNull();
  });
});

describe("describeAge", () => {
  const now = Date.parse("2026-08-26T12:00:00Z");

  it("describes how stale the list is", () => {
    expect(describeAge("2026-08-26T11:59:30Z", now)).toBe("just now");
    expect(describeAge("2026-08-26T11:45:00Z", now)).toBe("15m ago");
    expect(describeAge("2026-08-26T09:00:00Z", now)).toBe("3h ago");
  });

  it("says nothing without a usable timestamp", () => {
    expect(describeAge(undefined, now)).toBeNull();
    expect(describeAge("not a date", now)).toBeNull();
  });
});
