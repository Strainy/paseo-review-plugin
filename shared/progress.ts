import type { RefreshEvent } from "./reviews";

/**
 * The phase is the headline; `detail` carries whatever the server is actually
 * on — the current PR, a cache hit, or a throttling notice.
 */
export function describeProgress(progress: RefreshEvent | undefined): string | null {
  if (!progress || progress.phase === "idle" || progress.phase === "done") return null;
  return describeEvent(progress);
}

/** Always yields a line, including the terminal `done` summary the log shows. */
export function describeEvent(progress: RefreshEvent): string {
  const detail = progress.detail.trim();
  switch (progress.phase) {
    case "polling":
      return detail ? `Polling notifications — ${detail}` : "Polling notifications";
    case "filtering":
      return detail ? `Filtering — ${detail}` : "Filtering notifications";
    case "identifying":
      return detail ? `Identifying reviewer — ${detail}` : "Identifying reviewer";
    case "details":
      return [`Loading PR details ${progress.current}/${progress.total}`, detail || null]
        .filter(Boolean)
        .join(" — ");
    default:
      return detail;
  }
}

export function progressFraction(progress: RefreshEvent | undefined): number | null {
  if (!progress || progress.phase !== "details" || progress.total <= 0) return null;
  return Math.min(1, progress.current / progress.total);
}

export function describeAge(fetchedAt: string | undefined, now: number): string | null {
  if (!fetchedAt) return null;
  const parsed = Date.parse(fetchedAt);
  if (Number.isNaN(parsed)) return null;
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
