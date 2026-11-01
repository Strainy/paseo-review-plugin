import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { RpcInput } from "@getpaseo/plugin";
import { listReviews, type ReviewListResult } from "../shared/reviews";

type FetchReviews = (input: RpcInput<typeof listReviews>) => Promise<ReviewListResult>;

export function reviewListOptions(fetchReviews: FetchReviews) {
  return queryOptions({
    queryKey: ["reviews"],
    queryFn: () => fetchReviews({}),
    refetchInterval: (query) => query.state.data?.refreshIntervalMs ?? 120_000,
    staleTime: (query) => query.state.data?.refreshIntervalMs ?? 120_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function countUnreadReviews(snapshot: ReviewListResult | undefined): number {
  return snapshot?.pullRequests.filter((pullRequest) => pullRequest.unread).length ?? 0;
}

interface ReviewUnreadUpdate {
  id: string;
  unread: boolean;
}

export async function cancelReviewListQueries(client: QueryClient): Promise<void> {
  await Promise.all([
    client.cancelQueries({ queryKey: ["reviews"], exact: true }),
    client.cancelQueries({ queryKey: ["reviews", "cached"], exact: true }),
  ]);
}

export function updateReviewUnread(client: QueryClient, { id, unread }: ReviewUnreadUpdate) {
  for (const queryKey of [["reviews"], ["reviews", "cached"]]) {
    client.setQueryData<ReviewListResult>(queryKey, (snapshot) => {
      if (!snapshot) return snapshot;
      const pullRequests = snapshot.pullRequests.map((pullRequest) =>
        pullRequest.id === id ? { ...pullRequest, unread } : pullRequest,
      );
      return { ...snapshot, pullRequests };
    });
  }
}

export function removeReviewedPullRequest(client: QueryClient, id: string) {
  for (const queryKey of [["reviews"], ["reviews", "cached"]]) {
    client.setQueryData<ReviewListResult>(queryKey, (snapshot) => {
      if (!snapshot) return snapshot;
      const pullRequests = snapshot.pullRequests.filter((pullRequest) => pullRequest.id !== id);
      return { ...snapshot, pullRequests };
    });
  }
}
