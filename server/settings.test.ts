import { describe, expect, it } from "vitest";
import {
  lookupLegacyRepositoryPath,
  lookupRepositoryMapping,
  type RepositoryMap,
} from "./settings";

const mapping = {
  projectKey: "remote:github.com/acme/app",
  projectId: "project-a",
  projectName: "acme/app",
  projectRootPath: "/code/app",
  serverId: "host-a",
  serverName: "Laptop",
};

describe("repository mappings", () => {
  it("resolves project placements case-insensitively", () => {
    const repositories: RepositoryMap = { "acme/app": mapping };

    expect(lookupRepositoryMapping(repositories, "ACME/App")).toEqual(mapping);
    expect(lookupLegacyRepositoryPath(repositories, "ACME/App")).toBeNull();
  });

  it("keeps old path entries readable without treating them as project mappings", () => {
    const repositories: RepositoryMap = { "acme/app": "/code/app" };

    expect(lookupLegacyRepositoryPath(repositories, "acme/app")).toBe("/code/app");
    expect(lookupRepositoryMapping(repositories, "acme/app")).toBeNull();
  });
});
