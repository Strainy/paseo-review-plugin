import type { PaseoProject } from "@getpaseo/client";
import type { PluginHostSummary } from "@getpaseo/plugin/client";

export interface ProjectPlacement {
  readonly serverId: string;
  readonly serverName: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly projectRootPath: string;
  readonly projectKind: PaseoProject["projectKind"];
  readonly isOnline: boolean;
}

export interface ReviewProject {
  readonly projectKey: string;
  readonly projectName: string;
  readonly placements: readonly ProjectPlacement[];
}

export interface HostProjects {
  readonly host: PluginHostSummary;
  readonly projects: readonly PaseoProject[];
}

export function groupReviewProjects(hostProjects: readonly HostProjects[]): ReviewProject[] {
  const groups = new Map<string, { projectName: string; placements: ProjectPlacement[] }>();
  for (const { host, projects } of hostProjects) {
    for (const project of projects) {
      const projectKey = project.projectKey ?? project.projectId;
      const groupKey = project.projectKey ?? JSON.stringify([host.serverId, project.projectId]);
      const projectName = project.projectCustomName ?? project.projectDisplayName;
      const placement: ProjectPlacement = {
        serverId: host.serverId,
        serverName: host.label,
        projectId: project.projectId,
        projectKey,
        projectName,
        projectRootPath: project.projectRootPath,
        projectKind: project.projectKind,
        isOnline: host.status === "online",
      };
      const group = groups.get(groupKey);
      if (group) group.placements.push(placement);
      else groups.set(groupKey, { projectName, placements: [placement] });
    }
  }
  return Array.from(groups, ([projectKey, group]) => ({ projectKey, ...group })).sort(
    (left, right) => left.projectName.localeCompare(right.projectName),
  );
}
