import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadReadState,
  lookupLegacyRepositoryPath,
  lookupRepositoryMapping,
  saveReadAt,
  stateDirectory,
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

describe("read state persistence", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "paseo-read-state-"));
    vi.stubEnv("PASEO_HOME", directory);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps concurrent bulk reads and later mark-unread actions in order", async () => {
    await saveReadAt("acme/api#existing", "earlier");
    await Promise.all([
      ...Array.from({ length: 20 }, (_, number) => saveReadAt(`acme/api#${number}`, "read")),
      saveReadAt("acme/api#0", null),
      saveReadAt("acme/api#existing", null),
    ]);

    expect(await loadReadState()).toEqual(
      Object.fromEntries(
        Array.from({ length: 19 }, (_, number) => [`acme/api#${number + 1}`, "read"]),
      ),
    );
  });

  it("continues saving after a failed write", async () => {
    await mkdir(stateDirectory(), { recursive: true });
    const path = join(stateDirectory(), "read.json");
    await writeFile(path, "invalid json", "utf8");
    await expect(saveReadAt("acme/api#1", "read")).rejects.toThrow();

    await rm(path);
    await saveReadAt("acme/api#2", "read");
    expect(await loadReadState()).toEqual({ "acme/api#2": "read" });
  });
});
