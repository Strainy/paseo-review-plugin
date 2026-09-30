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

export interface ReviewDecision {
  state: PullRequest["reviewState"];
  viewerApproved: boolean;
}

function appliesToHead(commitId: string, headSha: string): boolean {
  return !commitId || !headSha || commitId === headSha;
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
  const decisions = new Map<string, { state: string; commitId: string }>();
  for (const review of reviews) {
    const login = review.user?.login?.trim().toLowerCase();
    if (!login) continue;
    const state = review.state?.toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED") {
      decisions.set(login, { state, commitId: review.commit_id });
    } else if (state === "DISMISSED") {
      decisions.delete(login);
    }
  }

  let state: PullRequest["reviewState"] = "unreviewed";
  for (const decision of decisions.values()) {
    if (decision.state === "CHANGES_REQUESTED") {
      state = "changes-requested";
      break;
    }
    if (decision.state === "APPROVED") state = "approved";
  }

  const viewerDecision = viewer ? decisions.get(viewer.trim().toLowerCase()) : undefined;
  return {
    state,
    viewerApproved:
      viewerDecision?.state === "APPROVED" && appliesToHead(viewerDecision.commitId, headSha),
  };
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
