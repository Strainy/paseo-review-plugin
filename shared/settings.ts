import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SETTINGS_STATUSES = [
  "open",
  "draft",
  "ready",
  "auto-merge",
  "approved",
  "bot-approved",
  "changes-requested",
  "unreviewed",
  "merged",
  "closed",
] as const;

export type SettingsStatus = (typeof SETTINGS_STATUSES)[number];

const AGE_PATTERN = /^([0-9]+)([dwh])$/;

const AgeSchema = z
  .string()
  .trim()
  .regex(AGE_PATTERN, "Use a number followed by h, d, or w, such as 48h, 30d, or 2w");

const FiltersSchema = z
  .object({
    repositories: z.array(z.string()).default([]),
    authors: z.array(z.string()).default([]),
    teams: z.array(z.string()).default([]),
    status: z.array(z.enum(SETTINGS_STATUSES)).default([]),
    lastUpdated: AgeSchema.optional(),
  })
  .default({ repositories: [], authors: [], teams: [], status: [] });

export const SettingsSchema = z.object({
  include: FiltersSchema,
  exclude: FiltersSchema,
  /**
   * Reviewer logins whose approvals count as bot approvals, for machine users
   * GitHub reports as ordinary accounts. `[bot]` accounts need no entry.
   */
  botReviewers: z.array(z.string()).default([]),
  /** Poll interval shared by the inbox and sidebar. */
  refreshIntervalMs: z
    .number()
    .int()
    .min(30_000, "Must be at least 30 seconds (30000 ms)")
    .default(120_000),
  /** Fallback provider when the project has no previous agent configuration. */
  agentProvider: z.string().trim().min(1, "Enter a provider, such as claude").default("claude"),
  /**
   * Upper bound on the notifications sweep, sent as `since`. Without it
   * `--paginate` walks your entire notification history: on a busy account that
   * is tens of MB and minutes per refresh. A shorter `lastUpdated` filter wins.
   */
  notificationLookback: AgeSchema.default("7d"),
  /**
   * Cap on stale or missing PR detail refreshes per poll. Each costs two serial
   * requests, so an unfiltered account would grind for thousands of them.
   * Cached candidates do not count toward the cap.
   */
  maxDetailFetches: z.number().int().min(1, "Must be at least 1").default(200),
  /**
   * Detail fetches in flight at once. Kept small on purpose: the point is to
   * hide round-trip latency, not to push GitHub toward a secondary limit.
   */
  detailConcurrency: z
    .number()
    .int()
    .min(1, "Must be between 1 and 10")
    .max(10, "Must be between 1 and 10")
    .default(4),
  cacheMaxBytes: z
    .number()
    .int()
    .min(1_048_576, "Must be at least 1 MB (1048576 bytes)")
    .default(50 * 1_048_576),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Filters = Settings["include"];

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

/** Field-qualified messages, such as `include.lastUpdated: Use a number...`. */
export function describeSettingsIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

export const readSettings = defineRpc({
  name: "reviews.settings.read",
  input: z.object({}),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ready"),
      path: z.string(),
      /** Opaque; a write must present the revision it was based on. */
      revision: z.string(),
      values: SettingsSchema,
    }),
    z.object({
      status: z.literal("invalid"),
      path: z.string(),
      revision: z.string(),
      error: z.string(),
    }),
  ]),
});

export type SettingsSnapshot = z.infer<typeof readSettings.output>;

export const writeSettings = defineRpc({
  name: "reviews.settings.write",
  // Validated by the handler, so a bad document is an `invalid` answer rather
  // than a transport error.
  input: z.object({ revision: z.string(), values: z.unknown() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved"), revision: z.string(), values: SettingsSchema }),
    z.object({ status: z.literal("conflict"), error: z.string() }),
    z.object({ status: z.literal("invalid"), error: z.string() }),
  ]),
});

export type SettingsWriteResult = z.infer<typeof writeSettings.output>;
