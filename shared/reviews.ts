import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const REVIEW_STATES = ["approved", "changes-requested", "unreviewed"] as const;

export const RepositoryProjectMappingSchema = z.object({
  projectKey: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  projectRootPath: z.string(),
  serverId: z.string(),
  serverName: z.string(),
});

export type RepositoryProjectMapping = z.infer<typeof RepositoryProjectMappingSchema>;

export const PullRequestSchema = z.object({
  /** `owner/repo#number`, stable across refreshes. */
  id: z.string(),
  repository: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  isDraft: z.boolean(),
  state: z.string(),
  merged: z.boolean(),
  autoMerge: z.boolean(),
  headSha: z.string(),
  requestedTeams: z.array(z.string()),
  updatedAt: z.string(),
  reviewState: z.enum(REVIEW_STATES),
  /** Legacy path mapping retained while old cache records age out. */
  repositoryPath: z.string().nullable(),
  /** Paseo project placement used to create review workspaces. */
  projectMapping: RepositoryProjectMappingSchema.nullable().default(null),
  /** False after the PR has been opened, until it is manually marked unread. */
  unread: z.boolean().default(true),
});

export type PullRequest = z.infer<typeof PullRequestSchema>;

export const listReviews = defineRpc({
  name: "reviews.list",
  input: z.object({
    /** Skip the notifications poll and answer from the on-disk cache. */
    cachedOnly: z.boolean().optional(),
  }),
  output: z.object({
    pullRequests: z.array(PullRequestSchema),
    viewer: z.string().nullable(),
    /** True when the answer came from cache because the poll failed. */
    stale: z.boolean(),
    error: z.string().nullable(),
    fetchedAt: z.string(),
    agentProvider: z.string(),
    refreshIntervalMs: z.number().int().positive(),
  }),
});

export type ReviewListResult = z.infer<typeof listReviews.output>;

export const REFRESH_PHASES = [
  "idle",
  "polling",
  "filtering",
  "identifying",
  "details",
  "done",
] as const;

export const RefreshEventSchema = z.object({
  phase: z.enum(REFRESH_PHASES),
  /** Free text for the item in flight, a retry notice, or a summary. */
  detail: z.string(),
  /** Populated during `details`; 0 when the phase has no countable work. */
  current: z.number().int().min(0),
  total: z.number().int().min(0),
});

export type RefreshEvent = z.infer<typeof RefreshEventSchema>;

export const RefreshProgressSchema = RefreshEventSchema.extend({
  /** Oldest first, bounded. The refresh log the TUI showed behind `d`. */
  history: z.array(RefreshEventSchema),
});

export type RefreshProgress = z.infer<typeof RefreshProgressSchema>;

export const readProgress = defineRpc({
  name: "reviews.progress",
  input: z.object({}),
  output: RefreshProgressSchema,
});

export const setPullRequestUnread = defineRpc({
  name: "reviews.unread.set",
  input: z.object({ id: z.string(), unread: z.boolean() }),
  output: z.object({ id: z.string(), unread: z.boolean() }),
});

export const pullRequestDetail = defineRpc({
  name: "reviews.detail",
  input: z.object({ id: z.string() }),
  output: z.object({
    id: z.string(),
    body: z.string(),
    diff: z.string(),
    /** Set when the diff was too large to send rather than silently cut. */
    diffTruncated: z.boolean(),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    changedFiles: z.number().int().min(0),
  }),
});

export const approveReview = defineRpc({
  name: "reviews.approve",
  input: z.object({ id: z.string() }),
  output: z.object({ approved: z.boolean() }),
});

export const mapRepository = defineRpc({
  name: "reviews.repositories.map",
  input: z.object({ repository: z.string(), mapping: RepositoryProjectMappingSchema }),
  output: z.object({ repository: z.string(), mapping: RepositoryProjectMappingSchema }),
});

export const readSettings = defineRpc({
  name: "reviews.settings.read",
  input: z.object({}),
  output: z.object({
    path: z.string(),
    /** Null when no settings file exists yet. */
    contents: z.string().nullable(),
  }),
});
