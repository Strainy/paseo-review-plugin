export type DiffTone = "add" | "context" | "meta" | "remove";

export interface DiffLineEntry {
  key: string;
  line: string;
  tone: DiffTone;
}

export interface DiffFileSection {
  key: string;
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLineEntry[];
}

export const MAX_RENDERED_DIFF_LINES = 2000;

interface PendingSection {
  headerPath: string | null;
  oldPath: string | null;
  newPath: string | null;
  additions: number;
  deletions: number;
  lines: Array<{ line: string; tone: DiffTone; sourceIndex: number }>;
}

function diffTone(line: string): DiffTone {
  if (
    line.startsWith("diff ") ||
    line.startsWith("@@") ||
    line.startsWith("+++") ||
    line.startsWith("---")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

function decodeGitPath(value: string): string {
  const path = value.split("\t", 1)[0] ?? value;
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

function markerPath(line: string, marker: string, prefix: string): string | null {
  if (!line.startsWith(marker)) return null;
  const path = decodeGitPath(line.slice(marker.length).trim());
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function headerPath(line: string): string | null {
  const separator = line.lastIndexOf(" b/");
  if (separator >= 0) return decodeGitPath(line.slice(separator + 1)).slice(2);
  const quotedMatch = line.match(/\s"b\/(.+)"$/);
  if (!quotedMatch?.[1]) return null;
  return decodeGitPath(`"${quotedMatch[1]}"`);
}

function createSection(header: string | null = null): PendingSection {
  return {
    headerPath: header,
    oldPath: null,
    newPath: null,
    additions: 0,
    deletions: 0,
    lines: [],
  };
}

function finishSection(section: PendingSection, index: number): DiffFileSection {
  const path = section.newPath ?? section.oldPath ?? section.headerPath ?? "Changes";
  return {
    key: `${path}-${index}`,
    path,
    additions: section.additions,
    deletions: section.deletions,
    lines: section.lines.map(({ line, tone, sourceIndex }) => ({
      key: `${index}-${sourceIndex}`,
      line,
      tone,
    })),
  };
}

export function parseUnifiedDiff(
  diff: string,
  maxLines = MAX_RENDERED_DIFF_LINES,
): DiffFileSection[] {
  const pending: PendingSection[] = [];
  let current: PendingSection | null = null;

  for (const [sourceIndex, line] of diff.split("\n").slice(0, maxLines).entries()) {
    if (line.startsWith("diff --git ")) {
      if (current) pending.push(current);
      current = createSection(headerPath(line));
    } else if (!current) {
      current = createSection();
    }

    if (line.startsWith("--- ")) current.oldPath = markerPath(line, "--- ", "a/");
    if (line.startsWith("+++ ")) current.newPath = markerPath(line, "+++ ", "b/");
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
    current.lines.push({ line, tone: diffTone(line), sourceIndex });
  }

  if (current) pending.push(current);
  return pending.map(finishSection);
}
