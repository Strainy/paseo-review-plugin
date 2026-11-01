import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationThread, RestPullRequest, RestReview } from "./github";

vi.mock("./github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github")>()),
  activeViewerLogin: vi.fn(),
  listReviewNotifications: vi.fn(),
  fetchPullRequest: vi.fn(),
  fetchReviews: vi.fn(),
  submitApproval: vi.fn(),
}));

function notification(number: number, updatedAt = "2026-08-26T10:00:00Z"): NotificationThread {
  return {
    id: String(number),
    reason: "review_requested",
    updated_at: updatedAt,
    subject: {
      title: `PR ${number}`,
      url: `https://api.github.com/repos/acme/api/pulls/${number}`,
      type: "PullRequest",
    },
    repository: { full_name: "acme/api" },
  };
}

function pullRequest(number: number, headSha = "abc123"): RestPullRequest {
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
    head: { sha: headSha },
    updated_at: "2026-08-26T10:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let stateHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  stateHome = await mkdtemp(path.join(tmpdir(), "paseo-review-approvals-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = stateHome;
  vi.resetModules();
  vi.resetAllMocks();
  const github = await import("./github");
  vi.mocked(github.activeViewerLogin).mockResolvedValue("kim");
  vi.mocked(github.listReviewNotifications).mockResolvedValue([notification(1)]);
  vi.mocked(github.fetchPullRequest).mockImplementation(async (endpoint) =>
    pullRequest(Number(endpoint.split("/").pop())),
  );
  vi.mocked(github.fetchReviews).mockResolvedValue([]);
  vi.mocked(github.submitApproval).mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(stateHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
});

describe("approval during refresh", () => {
  it("removes the final approved PR from live and cached lists", async () => {
    const { approve, list } = await import("./reviews");
    expect((await list({})).pullRequests).toHaveLength(1);

    await approve({ id: "acme/api#1" });

    expect((await list({})).pullRequests).toEqual([]);
    expect((await list({ cachedOnly: true })).pullRequests).toEqual([]);
  });

  it("keeps an approval when an older review fetch completes afterward", async () => {
    const { approve, list } = await import("./reviews");
    const github = await import("./github");
    await list({});
    vi.mocked(github.listReviewNotifications).mockResolvedValueOnce([
      notification(1, "2026-08-26T11:00:00Z"),
    ]);
    const reviews = deferred<RestReview[]>();
    vi.mocked(github.fetchReviews).mockReturnValueOnce(reviews.promise);
    const refreshing = list({});
    await vi.waitFor(() => expect(github.fetchReviews).toHaveBeenCalledTimes(2));

    await approve({ id: "acme/api#1" });
    reviews.resolve([]);

    expect((await refreshing).pullRequests).toEqual([]);
    expect((await list({ cachedOnly: true })).pullRequests).toEqual([]);
  });

  it("rechecks cached candidates approved while another PR is refreshing", async () => {
    const { approve, list } = await import("./reviews");
    const github = await import("./github");
    vi.mocked(github.listReviewNotifications).mockResolvedValueOnce([
      notification(1),
      notification(2),
    ]);
    await list({});
    vi.mocked(github.listReviewNotifications).mockResolvedValueOnce([
      notification(1),
      notification(2, "2026-08-26T11:00:00Z"),
    ]);
    const reviews = deferred<RestReview[]>();
    vi.mocked(github.fetchReviews).mockReturnValueOnce(reviews.promise);
    const refreshing = list({});
    await vi.waitFor(() => expect(github.fetchReviews).toHaveBeenCalledTimes(3));

    await approve({ id: "acme/api#1" });
    reviews.resolve([]);

    expect((await refreshing).pullRequests.map(({ id }) => id)).toEqual(["acme/api#2"]);
  });

  it("does not apply a pending approval to a newer head loaded in the meantime", async () => {
    const { approve, list } = await import("./reviews");
    const github = await import("./github");
    await list({});
    const submitted = deferred<void>();
    vi.mocked(github.submitApproval).mockReturnValueOnce(submitted.promise);
    const approving = approve({ id: "acme/api#1" });
    await vi.waitFor(() => expect(github.submitApproval).toHaveBeenCalledTimes(1));
    vi.mocked(github.listReviewNotifications).mockResolvedValueOnce([
      notification(1, "2026-08-26T11:00:00Z"),
    ]);
    vi.mocked(github.fetchPullRequest).mockResolvedValueOnce(pullRequest(1, "def456"));
    await list({});

    submitted.resolve();
    await approving;

    expect((await list({ cachedOnly: true })).pullRequests).toMatchObject([
      { id: "acme/api#1", headSha: "def456" },
    ]);
  });

  it("allows a new head after an approval to enter the queue", async () => {
    const { approve, list } = await import("./reviews");
    const github = await import("./github");
    await list({});
    await approve({ id: "acme/api#1" });
    vi.mocked(github.listReviewNotifications).mockResolvedValueOnce([
      notification(1, "2026-08-26T11:00:00Z"),
    ]);
    vi.mocked(github.fetchPullRequest).mockResolvedValueOnce(pullRequest(1, "def456"));
    vi.mocked(github.fetchReviews).mockResolvedValueOnce([
      { user: { login: "kim" }, state: "APPROVED", commit_id: "abc123", submitted_at: null },
    ]);

    expect((await list({})).pullRequests).toMatchObject([
      { id: "acme/api#1", headSha: "def456" },
    ]);
  });

  it("accepts a dismissal fetched after a completed approval", async () => {
    const { approve, list } = await import("./reviews");
    const github = await import("./github");
    await list({});
    await approve({ id: "acme/api#1" });
    vi.mocked(github.listReviewNotifications).mockResolvedValueOnce([
      notification(1, "2026-08-26T11:00:00Z"),
    ]);
    vi.mocked(github.fetchReviews).mockResolvedValueOnce([
      { user: { login: "kim" }, state: "DISMISSED", commit_id: "abc123", submitted_at: null },
    ]);

    expect((await list({})).pullRequests.map(({ id }) => id)).toEqual(["acme/api#1"]);
  });
});
