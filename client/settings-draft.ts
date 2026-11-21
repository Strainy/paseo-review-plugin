import { SETTINGS_STATUSES, SettingsSchema, type Settings, type SettingsStatus } from "../shared/settings";

export type FilterScope = "include" | "exclude";
type FilterList = "repositories" | "authors" | "teams";

export type ListField = `${FilterScope}.${FilterList}` | "botReviewers";

/** Text typed into a list's add box but not yet added, keyed by list. */
export type PendingEntries = Partial<Record<ListField, string>>;

export function readList(values: Settings, field: ListField): string[] {
  if (field === "botReviewers") return values.botReviewers;
  const [scope, list] = field.split(".") as [FilterScope, FilterList];
  return values[scope][list];
}

export function writeList(values: Settings, field: ListField, entries: string[]): Settings {
  if (field === "botReviewers") return { ...values, botReviewers: entries };
  const [scope, list] = field.split(".") as [FilterScope, FilterList];
  return { ...values, [scope]: { ...values[scope], [list]: entries } };
}

/** Commas and whitespace separate entries, so a pasted list adds in one go. */
export function parseEntries(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** Appends entries that are not already present, compared case-insensitively. */
export function addEntries(entries: readonly string[], additions: readonly string[]): string[] {
  const seen = new Set(entries.map((entry) => entry.toLowerCase()));
  const next = [...entries];
  for (const addition of additions) {
    const key = addition.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(addition);
  }
  return next;
}

/** Folds typed-but-unadded entries into the document, so Save does not drop them. */
export function withPendingEntries(values: Settings, pending: PendingEntries): Settings {
  let next = values;
  for (const [field, text] of Object.entries(pending) as [ListField, string | undefined][]) {
    const additions = parseEntries(text ?? "");
    if (additions.length > 0) next = writeList(next, field, addEntries(readList(next, field), additions));
  }
  return next;
}

export function toggleStatus(
  statuses: readonly SettingsStatus[],
  status: SettingsStatus,
): SettingsStatus[] {
  const enabled = !statuses.includes(status);
  // Keep the canonical order so toggling back and forth leaves the file unchanged.
  return SETTINGS_STATUSES.filter((candidate) =>
    candidate === status ? enabled : statuses.includes(candidate),
  );
}

/** An empty box clears the age rather than storing an invalid empty string. */
export function setLastUpdated(values: Settings, scope: FilterScope, text: string): Settings {
  const lastUpdated = text.trim() === "" ? undefined : text;
  return { ...values, [scope]: { ...values[scope], lastUpdated } };
}

export type NumberField =
  | "refreshIntervalMs"
  | "maxDetailFetches"
  | "detailConcurrency"
  | "cacheMaxBytes";

/** The file stores milliseconds and bytes; the form shows seconds and megabytes. */
export const NUMBER_UNITS: Record<NumberField, number> = {
  refreshIntervalMs: 1000,
  maxDetailFetches: 1,
  detailConcurrency: 1,
  cacheMaxBytes: 1_048_576,
};

export function formatNumber(field: NumberField, value: number): string {
  return String(Number((value / NUMBER_UNITS[field]).toFixed(2)));
}

/** Null when the text is not a number in the field's display unit. */
export function parseNumber(field: NumberField, text: string): number | null {
  const unit = NUMBER_UNITS[field];
  const pattern = unit === 1 ? /^\d+$/ : /^\d+(\.\d+)?$/;
  const trimmed = text.trim();
  if (!pattern.test(trimmed)) return null;
  return Math.round(Number(trimmed) * unit);
}

/** The first schema message per field, keyed by dotted path such as `include.lastUpdated`. */
export function validationErrors(values: Settings): Record<string, string> {
  const parsed = SettingsSchema.safeParse(values);
  if (parsed.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".");
    errors[key] ??= issue.message;
  }
  return errors;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

/** Structural equality that ignores key order and absent optional fields. */
export function sameSettings(a: Settings, b: Settings): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
