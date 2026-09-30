import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { PullRequestSchema, type PullRequest } from "../shared/reviews";
import { cachePath } from "./settings";

const RecordSchema = z.object({
  pullRequest: PullRequestSchema,
  /** Notification timestamp the details were fetched against. */
  notificationUpdatedAt: z.string(),
  /** Notification timestamp the review decision was fetched against. */
  reviewsUpdatedAt: z.string().nullable(),
  reviewViewer: z.string().nullable(),
  viewerApproved: z.boolean(),
});

export type CacheRecord = z.infer<typeof RecordSchema>;

/**
 * Append-only newline-delimited JSON. The newest record for an id wins, so a
 * refresh appends rather than rewrites; the file is compacted when it outgrows
 * its budget.
 */
export class PullRequestCache {
  private records = new Map<string, CacheRecord>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let contents: string;
    try {
      contents = await readFile(cachePath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = RecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) this.records.set(parsed.data.pullRequest.id, parsed.data);
      } catch {
        // A torn or outdated line is skipped; the poll refetches it.
      }
    }
  }

  get(id: string): CacheRecord | null {
    return this.records.get(id) ?? null;
  }

  all(): CacheRecord[] {
    return [...this.records.values()];
  }

  async put(record: CacheRecord, maxBytes: number): Promise<void> {
    this.records.set(record.pullRequest.id, record);
    const path = cachePath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    await this.compactIfNeeded(maxBytes);
  }

  private async compactIfNeeded(maxBytes: number): Promise<void> {
    const path = cachePath();
    const size = await stat(path)
      .then((stats) => stats.size)
      .catch(() => 0);
    if (size <= maxBytes) return;

    // Keep the newest unique records that fit, discarding older entries.
    const ordered = [...this.records.values()].sort(
      (a, b) => Date.parse(b.pullRequest.updatedAt) - Date.parse(a.pullRequest.updatedAt),
    );
    const kept: string[] = [];
    let bytes = 0;
    for (const record of ordered) {
      const line = `${JSON.stringify(record)}\n`;
      if (bytes + line.length > maxBytes) break;
      kept.push(line);
      bytes += line.length;
    }
    this.records = new Map(
      kept.map((line) => {
        const record = RecordSchema.parse(JSON.parse(line));
        return [record.pullRequest.id, record] as const;
      }),
    );
    await writeFile(path, kept.join(""), "utf8");
  }
}

export function cachedPullRequests(records: readonly CacheRecord[]): PullRequest[] {
  return records.map((record) => record.pullRequest);
}
