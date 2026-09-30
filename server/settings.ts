import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RepositoryProjectMappingSchema, type RepositoryProjectMapping } from "../shared/reviews";

const STATUSES = [
  "open",
  "draft",
  "ready",
  "auto-merge",
  "approved",
  "changes-requested",
  "unreviewed",
  "merged",
  "closed",
] as const;

const FiltersSchema = z
  .object({
    repositories: z.array(z.string()).default([]),
    authors: z.array(z.string()).default([]),
    teams: z.array(z.string()).default([]),
    status: z.array(z.enum(STATUSES)).default([]),
    lastUpdated: z.string().optional(),
  })
  .default({ repositories: [], authors: [], teams: [], status: [] });

export const SettingsSchema = z.object({
  include: FiltersSchema,
  exclude: FiltersSchema,
  /** Poll interval shared by the inbox and sidebar. */
  refreshIntervalMs: z.number().int().min(30_000).default(120_000),
  /** Fallback provider when the project has no previous agent configuration. */
  agentProvider: z.string().default("claude"),
  /**
   * Upper bound on the notifications sweep, sent as `since`. Without it
   * `--paginate` walks your entire notification history: on a busy account that
   * is tens of MB and minutes per refresh. A shorter `lastUpdated` filter wins.
   */
  notificationLookback: z.string().default("7d"),
  /**
   * Cap on stale or missing PR detail refreshes per poll. Each costs two serial
   * requests, so an unfiltered account would grind for thousands of them.
   * Cached candidates do not count toward the cap.
   */
  maxDetailFetches: z.number().int().min(1).default(200),
  /**
   * Detail fetches in flight at once. Kept small on purpose: the point is to
   * hide round-trip latency, not to push GitHub toward a secondary limit.
   */
  detailConcurrency: z.number().int().min(1).max(10).default(4),
  cacheMaxBytes: z
    .number()
    .int()
    .min(1_048_576)
    .default(50 * 1_048_576),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Filters = Settings["include"];

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

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Missing settings mean "every open PR I am asked to review", which is a usable
 * default. A malformed file is not silently ignored — the surface shows it.
 */
export async function loadSettings(): Promise<Settings> {
  const raw = await readJson(settingsPath());
  if (raw === null) return SettingsSchema.parse({ include: {}, exclude: {} });
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${settingsPath()} is not valid: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

export async function readSettingsFile(): Promise<string | null> {
  try {
    return await readFile(settingsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

export async function saveReadAt(id: string, readAt: string | null): Promise<void> {
  const current = await loadReadState();
  if (readAt === null) delete current[id];
  else current[id] = readAt;
  await writeJson(readStatePath(), current);
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

const AGE_PATTERN = /^([0-9]+)([dwh])$/;

/** Accepts `30d`, `2w`, `48h`. Returns milliseconds, or null when unset. */
export function parseLastUpdated(value: string | undefined): number | null {
  if (!value) return null;
  const match = AGE_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Invalid last-updated age: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "h") return amount * 3_600_000;
  if (unit === "d") return amount * 86_400_000;
  return amount * 604_800_000;
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
