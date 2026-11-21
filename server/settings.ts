import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RepositoryProjectMappingSchema, type RepositoryProjectMapping } from "../shared/reviews";
import {
  SettingsSchema,
  describeSettingsIssues,
  parseLastUpdated,
  type Settings,
  type SettingsSnapshot,
  type SettingsWriteResult,
} from "../shared/settings";

export { SettingsSchema, parseLastUpdated, type Filters, type Settings } from "../shared/settings";

const StoredRepositoryMappingSchema = z.union([z.string(), RepositoryProjectMappingSchema]);
const RepositoryMapSchema = z.record(z.string(), StoredRepositoryMappingSchema).default({});
export type RepositoryMap = z.infer<typeof RepositoryMapSchema>;
/** PR id -> a persisted marker written when the user reads the PR. */
const ReadStateSchema = z.record(z.string(), z.string()).default({});

export function stateDirectory(): string {
  const paseoHome = process.env.PASEO_HOME?.trim();
  const root = paseoHome ? paseoHome : join(homedir(), ".paseo");
  return join(root, "plugin-state", "paseo-review");
}

export function settingsPath(): string {
  return join(stateDirectory(), "settings.json");
}

function repositoryMapPath(): string {
  return join(stateDirectory(), "repositories.json");
}

function readStatePath(): string {
  return join(stateDirectory(), "read.json");
}

function legacyHiddenPath(): string {
  return join(stateDirectory(), "hidden.json");
}

export function cachePath(): string {
  return join(stateDirectory(), "pull-requests.jsonl");
}


async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, serializeJson(value));
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown | null> {
  const contents = await readText(path);
  return contents === null ? null : JSON.parse(contents);
}

function revisionOf(contents: string | null): string {
  return contents === null ? "missing" : createHash("sha256").update(contents).digest("hex");
}

/**
 * Missing settings mean "every open PR I am asked to review", which is a usable
 * default. A malformed file is reported rather than silently ignored, and is
 * never rewritten except by an explicit save against its revision.
 */
export async function readSettingsSnapshot(): Promise<SettingsSnapshot> {
  const path = settingsPath();
  const contents = await readText(path);
  const revision = revisionOf(contents);
  let document: unknown = {};
  if (contents !== null) {
    try {
      document = JSON.parse(contents);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: "invalid", path, revision, error: `Not valid JSON: ${reason}` };
    }
  }
  const parsed = SettingsSchema.safeParse(document);
  if (!parsed.success) {
    return { status: "invalid", path, revision, error: describeSettingsIssues(parsed.error) };
  }
  return { status: "ready", path, revision, values: parsed.data };
}

export async function loadSettings(): Promise<Settings> {
  const snapshot = await readSettingsSnapshot();
  if (snapshot.status === "invalid") {
    throw new Error(`${snapshot.path} is not valid: ${snapshot.error}`);
  }
  return snapshot.values;
}

let pendingSettingsWrite: Promise<unknown> = Promise.resolve();

/**
 * Replace the settings file, but only if it still matches `revision`: an
 * editor opened before a hand edit or another client's save must not silently
 * discard it. The whole document is written, defaults included.
 */
export function saveSettings(revision: string, values: unknown): Promise<SettingsWriteResult> {
  const write = pendingSettingsWrite.then(async (): Promise<SettingsWriteResult> => {
    const path = settingsPath();
    if (revisionOf(await readText(path)) !== revision) {
      return {
        status: "conflict",
        error: "Settings changed since they were loaded. Reload to see the latest values.",
      };
    }
    const parsed = SettingsSchema.safeParse(values);
    if (!parsed.success) return { status: "invalid", error: describeSettingsIssues(parsed.error) };
    const contents = serializeJson(parsed.data);
    await writeText(path, contents);
    return { status: "saved", revision: revisionOf(contents), values: parsed.data };
  });
  pendingSettingsWrite = write.catch(() => {});
  return write;
}

export async function loadRepositoryMap(): Promise<RepositoryMap> {
  const raw = await readJson(repositoryMapPath());
  if (raw === null) return {};
  const parsed = RepositoryMapSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export async function saveRepositoryMapping(
  repository: string,
  mapping: RepositoryProjectMapping,
): Promise<void> {
  const current = await loadRepositoryMap();
  await writeJson(repositoryMapPath(), { ...current, [repository.toLowerCase()]: mapping });
}

export async function loadReadState(): Promise<Record<string, string>> {
  let raw = await readJson(readStatePath());
  // The former Hide action used the same update-aware timestamp semantics.
  // Treat those entries as read until the first write moves state to read.json.
  if (raw === null) raw = await readJson(legacyHiddenPath());
  if (raw === null) return {};
  const parsed = ReadStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

let pendingReadWrite: Promise<void> = Promise.resolve();

export function saveReadAt(id: string, readAt: string | null): Promise<void> {
  // Selections and bulk actions can arrive together; keep each read-modify-write
  // intact so saving one PR cannot discard another PR's marker.
  const write = pendingReadWrite.then(async () => {
    const current = await loadReadState();
    if (readAt === null) delete current[id];
    else current[id] = readAt;
    await writeJson(readStatePath(), current);
  });
  pendingReadWrite = write.catch(() => {});
  return write;
}

/**
 * Read state belongs to the PR, not to one revision of it. The stored value is
 * retained for compatibility with the original timestamp-based format; only
 * the presence of the id matters now.
 */
export function isUnread(readState: Record<string, string>, id: string): boolean {
  return !Object.hasOwn(readState, id);
}

export function lookupRepositoryMapping(
  map: RepositoryMap,
  repository: string,
): RepositoryProjectMapping | null {
  const mapping = map[repository.toLowerCase()];
  return typeof mapping === "string" || mapping === undefined ? null : mapping;
}

export function lookupLegacyRepositoryPath(map: RepositoryMap, repository: string): string | null {
  const mapping = map[repository.toLowerCase()];
  return typeof mapping === "string" ? mapping : null;
}

/**
 * The shorter age wins, matching gh-review-tui. Unlike the TUI this always
 * returns a bound: an unbounded sweep is what makes a fresh install look broken.
 */
export function lastUpdatedCutoff(settings: Settings, now: number): number {
  const ages = [
    settings.include.lastUpdated,
    settings.exclude.lastUpdated,
    settings.notificationLookback,
  ]
    .map(parseLastUpdated)
    .filter((age): age is number => age !== null);
  return now - Math.min(...ages);
}
