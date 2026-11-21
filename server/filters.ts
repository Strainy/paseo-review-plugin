import type { RestPullRequest, RestReview } from "./github";
import type { Filters, Settings } from "./settings";
import { parseLastUpdated } from "./settings";
import type { PullRequest } from "../shared/reviews";

/** `lpu-renovate` matches GitHub's `lpu-renovate[bot]`. */
function canonicalAuthor(author: string): string {
  return author.toLowerCase().replace(/\[bot\]$/, "");
}

/** A bare slug inherits the organization from the PR's own repository. */
function qualifyTeams(teams: readonly string[], repository: string): string[] {
  const owner = repository.split("/")[0] ?? "";
  return teams.map((team) => (team.includes("/") ? team : `${owner}/${team}`).toLowerCase());
}

export function requestedTeamNames(pr: RestPullRequest, repository: string): string[] {
  const owner = repository.split("/")[0] ?? "";
  return (pr.requested_teams ?? []).map(
    (team) => `${team.organization?.login || owner}/${team.slug}`,
  );
}

export interface Approver {
  login: string;
  /** GitHub's own signal: a GitHub App account or a `[bot]` login. */
  bot: boolean;
}

export interface ReviewDecision {
  /** `approved` here still includes bot approvals; see `resolveReviewState`. */
  state: PullRequest["reviewState"];
  /** Reviewers whose standing decision is an approval. */
  approvers: Approver[];
  viewerApproved: boolean;
}

function appliesToHead(commitId: string, headSha: string): boolean {
  return !commitId || !headSha || commitId === headSha;
}

function isGitHubBot(user: NonNullable<RestReview["user"]>): boolean {
  return user.type?.toLowerCase() === "bot" || /\[bot\]$/i.test(user.login.trim());
}

/**
 * Comment-only reviews carry no decision and dismissals clear one. Changes
 * requested wins over approval. Submitted approvals remain visible across new
 * commits; the current-head check applies only to whether the viewer is done.
 */
export function materializeReviewState(
  reviews: readonly RestReview[],
  viewer: string | null,
  headSha: string,
): ReviewDecision {
  const decisions = new Map<string, { state: string; commitId: string; approver: Approver }>();
  for (const review of reviews) {
    const user = review.user;
    const login = user?.login?.trim().toLowerCase();
    if (!user || !login) continue;
    const state = review.state?.toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED") {
      decisions.set(login, {
        state,
        commitId: review.commit_id,
        approver: { login: user.login.trim(), bot: isGitHubBot(user) },
      });
    } else if (state === "DISMISSED") {
      decisions.delete(login);
    }
  }

  const standing = [...decisions.values()];
  const approvals = standing.filter((decision) => decision.state === "APPROVED");
  let state: PullRequest["reviewState"] = approvals.length > 0 ? "approved" : "unreviewed";
  if (standing.some((decision) => decision.state === "CHANGES_REQUESTED")) {
    state = "changes-requested";
  }

  const viewerDecision = viewer ? decisions.get(viewer.trim().toLowerCase()) : undefined;
  return {
    state,
    approvers: approvals.map((decision) => decision.approver),
    viewerApproved:
      viewerDecision?.state === "APPROVED" && appliesToHead(viewerDecision.commitId, headSha),
  };
}

/**
 * An approval is a bot approval only when every approver is a bot, either by
 * GitHub's account type or by `botReviewers`, which covers machine users that
 * GitHub reports as ordinary accounts. One human approval makes it `approved`.
 * Applied when the list is built so a settings change needs no refetch.
 */
export function resolveReviewState(
  state: PullRequest["reviewState"],
  approvers: readonly Approver[],
  botReviewers: readonly string[],
): PullRequest["reviewState"] {
  if (state !== "approved" || approvers.length === 0) return state;
  const configured = new Set(botReviewers.map(canonicalAuthor));
  const human = approvers.some(
    (approver) => !approver.bot && !configured.has(canonicalAuthor(approver.login)),
  );
  return human ? "approved" : "bot-approved";
}

export function matchesNotificationRepository(repository: string, settings: Settings): boolean {
  const lowered = repository.toLowerCase();
  if (settings.exclude.repositories.some((entry) => entry.toLowerCase() === lowered)) return false;
  if (settings.include.repositories.length === 0) return true;
  return settings.include.repositories.some((entry) => entry.toLowerCase() === lowered);
}

function matchesAnyStatus(pr: PullRequest, statuses: readonly string[]): boolean {
  const isOpen = pr.state.toLowerCase() === "open";
  return statuses.some((status) => {
    switch (status) {
      case "open":
        return isOpen;
      case "draft":
        return isOpen && pr.isDraft;
      case "ready":
        return isOpen && !pr.isDraft;
      case "auto-merge":
        return isOpen && pr.autoMerge;
      case "approved":
        return pr.reviewState === "approved";
      case "bot-approved":
        return pr.reviewState === "bot-approved";
      case "changes-requested":
        return pr.reviewState === "changes-requested";
      case "unreviewed":
        return pr.reviewState === "unreviewed";
      case "merged":
        return pr.merged;
      case "closed":
        return pr.state.toLowerCase() === "closed" && !pr.merged;
      default:
        return false;
    }
  });
}

function excluded(pr: PullRequest, filters: Filters): boolean {
  const repository = pr.repository.toLowerCase();
  if (filters.repositories.some((entry) => entry.toLowerCase() === repository)) return true;
  const author = canonicalAuthor(pr.author);
  if (filters.authors.some((entry) => canonicalAuthor(entry) === author)) return true;
  const teams = qualifyTeams(filters.teams, pr.repository);
  if (pr.requestedTeams.some((requested) => teams.includes(requested.toLowerCase()))) return true;
  return matchesAnyStatus(pr, filters.status);
}

/** Authors and teams are additive: either one matching includes the PR. */
function matchesIncludedPeople(pr: PullRequest, filters: Filters): boolean {
  if (filters.authors.length === 0 && filters.teams.length === 0) return true;
  const author = canonicalAuthor(pr.author);
  if (filters.authors.some((entry) => canonicalAuthor(entry) === author)) return true;
  const teams = qualifyTeams(filters.teams, pr.repository);
  return pr.requestedTeams.some((requested) => teams.includes(requested.toLowerCase()));
}

function matchesIncludedStatus(pr: PullRequest, statuses: readonly string[]): boolean {
  // With no status configured, show open PRs including drafts.
  if (statuses.length === 0) return pr.state.toLowerCase() === "open";
  return matchesAnyStatus(pr, statuses);
}

function matchesLastUpdated(pr: PullRequest, settings: Settings, now: number): boolean {
  const updatedAt = Date.parse(pr.updatedAt);
  if (Number.isNaN(updatedAt)) return true;
  for (const value of [settings.include.lastUpdated, settings.exclude.lastUpdated]) {
    const age = parseLastUpdated(value);
    if (age !== null && updatedAt < now - age) return false;
  }
  return true;
}

export function includePullRequest(
  pr: PullRequest,
  settings: Settings,
  viewerApproved: boolean,
  now: number,
): boolean {
  // A PR the active account already approved is never a review request.
  if (viewerApproved) return false;
  if (excluded(pr, settings.exclude)) return false;
  if (!matchesIncludedPeople(pr, settings.include)) return false;
  if (!matchesIncludedStatus(pr, settings.include.status)) return false;
  return matchesLastUpdated(pr, settings, now);
}
