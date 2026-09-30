import { describe, expect, it } from "vitest";
import type { input as ZodInput } from "zod";
import { includePullRequest, materializeReviewState } from "./filters";
import { SettingsSchema, isUnread, parseLastUpdated, type Settings } from "./settings";
import type { PullRequest } from "../shared/reviews";

type SettingsInput = ZodInput<typeof SettingsSchema>;

function settings(overrides: Partial<SettingsInput> = {}): Settings {
  return SettingsSchema.parse({ include: {}, exclude: {}, ...overrides });
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "acme/api#1",
    repository: "acme/api",
    number: 1,
    title: "Add a thing",
    url: "https://github.com/acme/api/pull/1",
    author: "someone",
    isDraft: false,
    state: "open",
    merged: false,
    autoMerge: false,
    headSha: "abc123",
    requestedTeams: [],
    updatedAt: new Date().toISOString(),
    reviewState: "unreviewed",
    repositoryPath: null,
    projectMapping: null,
    unread: true,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-26T12:00:00Z");

describe("materializeReviewState", () => {
  it("treats a PR with no submitted decision as unreviewed", () => {
    expect(materializeReviewState([], null, "abc123").state).toBe("unreviewed");
  });

  it("ignores comment-only reviews", () => {
    const reviews = [
      { user: { login: "kim" }, state: "COMMENTED", commit_id: "abc123", submitted_at: null },
    ];
    expect(materializeReviewState(reviews, null, "abc123").state).toBe("unreviewed");
  });

  it("lets changes-requested win over an approval", () => {
    const reviews = [
      { user: { login: "kim" }, state: "APPROVED", commit_id: "abc123", submitted_at: null },
      {
        user: { login: "sam" },
        state: "CHANGES_REQUESTED",
        commit_id: "abc123",
        submitted_at: null,
      },
    ];
    expect(materializeReviewState(reviews, null, "abc123").state).toBe("changes-requested");
  });

  it("keeps only a reviewer's latest decision", () => {
    const reviews = [
      {
        user: { login: "kim" },
        state: "CHANGES_REQUESTED",
        commit_id: "abc123",
        submitted_at: null,
      },
      { user: { login: "kim" }, state: "APPROVED", commit_id: "abc123", submitted_at: null },
    ];
    expect(materializeReviewState(reviews, null, "abc123").state).toBe("approved");
  });

  it("clears a decision that was dismissed", () => {
    const reviews = [
      { user: { login: "kim" }, state: "APPROVED", commit_id: "abc123", submitted_at: null },
      { user: { login: "kim" }, state: "DISMISSED", commit_id: "abc123", submitted_at: null },
    ];
    expect(materializeReviewState(reviews, null, "abc123").state).toBe("unreviewed");
  });

  it("keeps an approval visible after a new commit while making the new head reviewable", () => {
    const reviews = [
      { user: { login: "kim" }, state: "APPROVED", commit_id: "old-sha", submitted_at: null },
    ];
    expect(materializeReviewState(reviews, "kim", "new-sha")).toEqual({
      state: "approved",
      viewerApproved: false,
    });
  });

  it("reports the viewer's own approval against the current head", () => {
    const reviews = [
      { user: { login: "Kim" }, state: "APPROVED", commit_id: "abc123", submitted_at: null },
    ];
    expect(materializeReviewState(reviews, "kim", "abc123").viewerApproved).toBe(true);
  });
});

describe("includePullRequest", () => {
  it("hides a PR the active account already approved", () => {
    expect(includePullRequest(pullRequest(), settings(), true, NOW)).toBe(false);
  });

  it("shows every open PR when nothing is configured", () => {
    expect(includePullRequest(pullRequest(), settings(), false, NOW)).toBe(true);
  });

  it("omits merged and closed PRs by default", () => {
    expect(includePullRequest(pullRequest({ state: "closed" }), settings(), false, NOW)).toBe(
      false,
    );
  });

  it("includes drafts by default but not under a ready filter", () => {
    const draft = pullRequest({ isDraft: true });
    expect(includePullRequest(draft, settings(), false, NOW)).toBe(true);
    expect(
      includePullRequest(draft, settings({ include: { status: ["ready"] } }), false, NOW),
    ).toBe(false);
  });

  it("matches a bot exclusion without its [bot] suffix", () => {
    const pr = pullRequest({ author: "acme-renovate[bot]" });
    const config = settings({ exclude: { authors: ["acme-renovate"] } });
    expect(includePullRequest(pr, config, false, NOW)).toBe(false);
  });

  it("treats include authors and teams as additive", () => {
    const config = settings({ include: { authors: ["someone-else"], teams: ["infra"] } });
    expect(includePullRequest(pullRequest(), config, false, NOW)).toBe(false);
    expect(
      includePullRequest(pullRequest({ requestedTeams: ["acme/infra"] }), config, false, NOW),
    ).toBe(true);
  });

  it("qualifies a bare team slug with the PR's own organization", () => {
    const config = settings({ include: { teams: ["infra"] } });
    expect(
      includePullRequest(pullRequest({ requestedTeams: ["other/infra"] }), config, false, NOW),
    ).toBe(false);
  });

  it("lets an exclusion beat an inclusion", () => {
    const config = settings({
      include: { authors: ["someone"] } as never,
      exclude: { authors: ["someone"] } as never,
    });
    expect(includePullRequest(pullRequest(), config, false, NOW)).toBe(false);
  });

  it("drops a PR older than the configured age", () => {
    const stale = pullRequest({ updatedAt: new Date(NOW - 40 * 86_400_000).toISOString() });
    const config = settings({ include: { lastUpdated: "30d" } });
    expect(includePullRequest(stale, config, false, NOW)).toBe(false);
    expect(includePullRequest(pullRequest(), config, false, NOW)).toBe(true);
  });
});

describe("parseLastUpdated", () => {
  it("accepts days, weeks, and hours", () => {
    expect(parseLastUpdated("30d")).toBe(30 * 86_400_000);
    expect(parseLastUpdated("2w")).toBe(2 * 604_800_000);
    expect(parseLastUpdated("48h")).toBe(48 * 3_600_000);
  });

  it("rejects an unparseable age rather than silently ignoring it", () => {
    expect(() => parseLastUpdated("soon")).toThrow(/Invalid last-updated age/);
  });
});

describe("isUnread", () => {
  const readState = { "acme/api#1": "2026-08-26T12:00:00Z" };

  it("keeps a PR read after later GitHub updates", () => {
    expect(isUnread(readState, "acme/api#1")).toBe(false);
  });

  it("treats PRs that have never been opened as unread", () => {
    expect(isUnread(readState, "acme/api#2")).toBe(true);
    expect(isUnread({}, "acme/api#1")).toBe(true);
  });

  it("accepts existing timestamp markers without interpreting their value", () => {
    expect(isUnread({ "acme/api#1": "nonsense" }, "acme/api#1")).toBe(false);
  });
});
