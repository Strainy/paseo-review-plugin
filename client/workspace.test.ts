import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { groupReviewProjects, type ProjectPlacement } from "./projects";
import type { PullRequest } from "../shared/reviews";
import {
  resolveAgentProviderModel,
  resolveProjectPlacement,
  resolveReviewAgentConfig,
  reviewWorkspaceCreateOptions,
} from "./workspace";

const placement: ProjectPlacement = {
  serverId: "host-a",
  serverName: "Laptop",
  projectId: "project-a",
  projectKey: "remote:github.com/acme/app",
  projectName: "acme/app",
  projectRootPath: "/code/app",
  projectKind: "git",
  isOnline: true,
};

const pullRequest = {
  id: "acme/app#42",
  number: 42,
} as PullRequest;

describe("reviewWorkspaceCreateOptions", () => {
  it("creates a PR worktree under the mapped project", () => {
    expect(reviewWorkspaceCreateOptions(pullRequest, placement)).toEqual({
      title: "Review acme/app#42",
      source: {
        kind: "worktree",
        cwd: "/code/app",
        projectId: "project-a",
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: "github", number: 42 },
      },
    });
  });
});

describe("resolveReviewAgentConfig", () => {
  it("inherits the most recently used model, effort, and permission mode for the project", async () => {
    const list = vi.fn().mockResolvedValue({
      entries: [
        {
          agent: {
            provider: "codex",
            model: "gpt-5.5",
            thinkingOptionId: "high",
            effectiveThinkingOptionId: "high",
            currentModeId: "full-access",
          },
        },
      ],
    });
    const waitForReady = vi.fn();
    const paseo = {
      agents: { list },
      providers: { waitForReady },
    } as unknown as Pick<PaseoApi, "agents" | "providers">;

    await expect(
      resolveReviewAgentConfig(paseo, {
        projectKey: "remote:github.com/acme/app",
        cwd: "/code/app",
        fallbackProvider: "claude",
      }),
    ).resolves.toEqual({
      provider: "codex/gpt-5.5",
      thinkingOptionId: "high",
      modeId: "full-access",
    });
    expect(list).toHaveBeenCalledWith({
      filter: {
        projectKeys: ["remote:github.com/acme/app"],
        includeArchived: true,
      },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 1 },
    });
    expect(waitForReady).not.toHaveBeenCalled();
  });
});

describe("resolveAgentProviderModel", () => {
  it("resolves a provider-only setting to the selected host's default model", async () => {
    const waitForReady = vi.fn().mockResolvedValue({
      entries: [
        {
          provider: "claude",
          status: "ready",
          enabled: true,
          models: [
            { provider: "claude", id: "sonnet", label: "Sonnet" },
            { provider: "claude", id: "opus", label: "Opus", isDefault: true },
          ],
        },
      ],
    });
    const paseo = { providers: { waitForReady } } as unknown as Pick<PaseoApi, "providers">;

    await expect(resolveAgentProviderModel(paseo, "claude", "/code/app")).resolves.toBe(
      "claude/opus",
    );
    expect(waitForReady).toHaveBeenCalledWith({ cwd: "/code/app" });
  });

  it("keeps an explicit provider/model selection without loading the catalog", async () => {
    const waitForReady = vi.fn();
    const paseo = { providers: { waitForReady } } as unknown as Pick<PaseoApi, "providers">;

    await expect(resolveAgentProviderModel(paseo, "codex/gpt-5.5", "/code/app")).resolves.toBe(
      "codex/gpt-5.5",
    );
    expect(waitForReady).not.toHaveBeenCalled();
  });
});

describe("review project discovery", () => {
  it("groups the same repository across hosts and keeps cached offline placements", () => {
    const project = {
      projectId: "project-a",
      projectKey: "remote:github.com/acme/app",
      projectDisplayName: "acme/app",
      projectCustomName: "App",
      projectRootPath: "/code/app",
      projectKind: "git" as const,
    };
    expect(
      groupReviewProjects([
        { host: { serverId: "host-a", label: "Laptop", status: "online" }, projects: [project] },
        {
          host: { serverId: "host-b", label: "Desktop", status: "offline" },
          projects: [{ ...project, projectId: "project-b", projectRootPath: "/work/app" }],
        },
      ]),
    ).toEqual([
      {
        projectKey: project.projectKey,
        projectName: "App",
        placements: [
          { ...placement, projectName: "App" },
          {
            ...placement,
            projectName: "App",
            serverId: "host-b",
            serverName: "Desktop",
            projectId: "project-b",
            projectRootPath: "/work/app",
            isOnline: false,
          },
        ],
      },
    ]);
  });

  it("resolves existing mappings by host and project ID when their view key differs", () => {
    const mapping = { ...placement, projectKey: JSON.stringify(["host-a", "project-a"]) };
    const projects = [
      { projectKey: placement.projectKey, projectName: "App", placements: [placement] },
    ];
    expect(resolveProjectPlacement(projects, mapping)).toEqual(placement);
    expect(resolveProjectPlacement(projects, { ...mapping, serverId: "host-b" })).toBeNull();
    expect(resolveProjectPlacement(projects, { ...mapping, projectId: "removed" })).toBeNull();
  });

  it("keeps projects without a cross-host key separate", () => {
    const project = {
      projectId: "project-a",
      projectDisplayName: "acme/app",
      projectRootPath: "/code/app",
      projectKind: "git" as const,
    };
    const projects = groupReviewProjects([
      { host: { serverId: "host-a", label: "Laptop", status: "online" }, projects: [project] },
      { host: { serverId: "host-b", label: "Desktop", status: "online" }, projects: [project] },
    ]);
    expect(projects.map((entry) => entry.projectKey)).toEqual([
      JSON.stringify(["host-a", "project-a"]),
      JSON.stringify(["host-b", "project-a"]),
    ]);
  });
});
