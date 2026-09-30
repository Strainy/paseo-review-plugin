import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { useQueries } from "@tanstack/react-query";
import { groupReviewProjects } from "./projects";

export function useReviewProjects() {
  const hosts = useHosts();
  const queries = useQueries({
    queries: hosts.map((host) => ({
      queryKey: ["review-projects", host.serverId],
      queryFn: async () => (await getPaseoClient(host.serverId).projects.list()).projects,
      enabled: host.status === "online",
      refetchInterval: 30_000,
      retry: false,
    })),
  });
  const projects = groupReviewProjects(
    hosts.map((host, index) => ({ host, projects: queries[index].data ?? [] })),
  );
  const errors = queries.flatMap((query, index) =>
    hosts[index].status === "online" && query.error
      ? [`${hosts[index].label}: ${query.error.message}`]
      : [],
  );
  let status: string | null = null;
  if (errors.length > 0) status = `Could not load projects. ${errors.join("; ")}`;
  else if (queries.some((query) => query.isLoading)) status = "Loading projects...";
  return { projects, status };
}
