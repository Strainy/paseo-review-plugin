import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { listReviews } from "../shared/reviews";
import { countUnreadReviews, reviewListOptions } from "./reviews";

export function useReviewList(hostId: string) {
  const hosts = useHosts();
  const isOnline = hosts.some((host) => host.serverId === hostId && host.status === "online");
  const fetchReviews = useRpc(listReviews);
  const reviews = useQuery({ ...reviewListOptions(fetchReviews), enabled: isOnline });
  const cached = useQuery({
    queryKey: ["reviews", "cached"],
    queryFn: () => fetchReviews({ cachedOnly: true }),
    enabled: isOnline,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const snapshot = reviews.data ?? cached.data;
  const showingCache = reviews.data === undefined && cached.data !== undefined;
  return { reviews, snapshot, showingCache, isOnline, unreadCount: countUnreadReviews(snapshot) };
}
