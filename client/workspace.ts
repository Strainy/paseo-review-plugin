import type { PaseoAgentConfig, PaseoApi, PaseoWorkspaceCreateOptions } from "@getpaseo/client";
import type { ProjectPlacement, ReviewProject } from "./projects";
import type { PullRequest, RepositoryProjectMapping } from "../shared/reviews";

export async function resolveAgentProviderModel(
  paseo: Pick<PaseoApi, "providers">,
  configuredProvider: string,
  cwd: string,
): Promise<string> {
  const selection = configuredProvider.trim();
  const separator = selection.indexOf("/");
  if (separator > 0 && separator < selection.length - 1) return selection;
  if (separator >= 0 || selection.length === 0) {
    throw new Error('agentProvider must be a provider or use "provider/model" format.');
  }

  const snapshot = await paseo.providers.waitForReady({ cwd });
  const provider = snapshot.entries.find((entry) => entry.provider === selection);
  if (!provider) throw new Error(`Agent provider "${selection}" is not configured on this host.`);
  if (!provider.enabled) throw new Error(`Agent provider "${selection}" is disabled on this host.`);
  if (provider.status !== "ready") {
    throw new Error(
      provider.error ?? `Agent provider "${selection}" is ${provider.status} on this host.`,
    );
  }

  const selectableModels = (provider.models ?? []).filter((model) => model.isSelectable !== false);
  const model = selectableModels.find((candidate) => candidate.isDefault) ?? selectableModels.at(0);
  if (!model) throw new Error(`Agent provider "${selection}" has no selectable models.`);
  return `${selection}/${model.id}`;
}

export async function resolveReviewAgentConfig(
  paseo: Pick<PaseoApi, "agents" | "providers">,
  input: {
    projectKey: string;
    cwd: string;
    fallbackProvider: string;
  },
): Promise<PaseoAgentConfig> {
  const recent = await paseo.agents.list({
    filter: { projectKeys: [input.projectKey], includeArchived: true },
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: 1 },
  });
  const previous = recent.entries.at(0)?.agent;
  if (!previous) {
    return {
      provider: await resolveAgentProviderModel(paseo, input.fallbackProvider, input.cwd),
    };
  }

  const provider = previous.model
    ? `${previous.provider}/${previous.model}`
    : await resolveAgentProviderModel(paseo, previous.provider, input.cwd);
  const thinkingOptionId = previous.thinkingOptionId ?? previous.effectiveThinkingOptionId;
  return {
    provider,
    ...(previous.currentModeId ? { modeId: previous.currentModeId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

export function reviewWorkspaceCreateOptions(
  pullRequest: PullRequest,
  placement: ProjectPlacement,
): PaseoWorkspaceCreateOptions {
  const title = `Review ${pullRequest.id}`;
  return {
    title,
    source: {
      kind: "worktree",
      cwd: placement.projectRootPath,
      projectId: placement.projectId,
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        forge: "github",
        number: pullRequest.number,
      },
    },
  };
}

export function resolveProjectPlacement(
  projects: readonly ReviewProject[],
  mapping: RepositoryProjectMapping | null | undefined,
): ProjectPlacement | null {
  if (!mapping) return null;
  // Older mappings stored the app's view key, which is not the SDK project key.
  for (const project of projects) {
    const placement = project.placements.find(
      (candidate) =>
        candidate.serverId === mapping.serverId && candidate.projectId === mapping.projectId,
    );
    if (placement) return placement;
  }
  return null;
}
