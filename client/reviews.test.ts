import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { listReviews, PullRequestSchema, type ReviewListResult } from "../shared/reviews";
import {
  countUnreadReviews,
  removeReviewedPullRequest,
  reviewListOptions,
  updateReviewUnread,
} from "./reviews";

function snapshot(): ReviewListResult {
  return listReviews.output.parse({
    pullRequests: [1, 2].map((number) =>
      PullRequestSchema.parse({
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
      }),
    ),
    viewer: "kim",
    stale: false,
    error: null,
    fetchedAt: "2026-10-01T00:00:00Z",
    agentProvider: "claude",
    refreshIntervalMs: 120_000,
  });
}

describe("sidebar review query", () => {
  it("rolls back read state in both caches without changing another host's count", () => {
    const host = new QueryClient();
    const otherHost = new QueryClient();
    for (const client of [host, otherHost]) {
      client.setQueryData(["reviews"], snapshot());
      client.setQueryData(["reviews", "cached"], snapshot());
    }
    try {
      updateReviewUnread(host, { id: "acme/api#1", unread: false });
      expect(countUnreadReviews(host.getQueryData(["reviews"]))).toBe(1);
      expect(countUnreadReviews(host.getQueryData(["reviews", "cached"]))).toBe(1);
      expect(countUnreadReviews(otherHost.getQueryData(["reviews"]))).toBe(2);
      updateReviewUnread(host, { id: "acme/api#1", unread: true });
      expect(countUnreadReviews(host.getQueryData(["reviews"]))).toBe(2);
      expect(countUnreadReviews(host.getQueryData(["reviews", "cached"]))).toBe(2);
    } finally {
      host.clear();
      otherHost.clear();
    }
  });

  it("removes an approved PR from the inbox and badge before the next poll", () => {
    const client = new QueryClient();
    client.setQueryData(["reviews"], snapshot());
    client.setQueryData(["reviews", "cached"], snapshot());
    const sidebar = new QueryObserver(client, {
      ...reviewListOptions(async () => snapshot()),
      select: countUnreadReviews,
    });
    const unsubscribe = sidebar.subscribe(() => {});
    try {
      removeReviewedPullRequest(client, "acme/api#1");
      expect(sidebar.getCurrentResult().data).toBe(1);
      expect(
        client
          .getQueryData<ReviewListResult>(["reviews", "cached"])
          ?.pullRequests.map((pr) => pr.id),
      ).toEqual(["acme/api#2"]);
      removeReviewedPullRequest(client, "acme/api#2");
      expect(sidebar.getCurrentResult().data).toBe(0);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("shares a request and immediate read-state updates with the inbox", async () => {
    const client = new QueryClient();
    const fetchReviews = vi.fn(async () => snapshot());
    const options = reviewListOptions(fetchReviews);
    const inbox = new QueryObserver(client, options);
    const sidebar = new QueryObserver(client, { ...options, select: countUnreadReviews });
    const unsubscribeInbox = inbox.subscribe(() => {});
    const unsubscribeSidebar = sidebar.subscribe(() => {});
    try {
      await Promise.all([inbox.refetch(), sidebar.refetch()]);
      expect(fetchReviews).toHaveBeenCalledTimes(1);
      expect(sidebar.getCurrentResult().data).toBe(2);

      updateReviewUnread(client, { id: "acme/api#1", unread: false });
      expect(sidebar.getCurrentResult().data).toBe(1);
      expect(inbox.getCurrentResult().data?.pullRequests[0].unread).toBe(false);

      updateReviewUnread(client, { id: "acme/api#1", unread: true });
      expect(sidebar.getCurrentResult().data).toBe(2);
      expect(fetchReviews).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribeInbox();
      unsubscribeSidebar();
      client.clear();
    }
  });
});
