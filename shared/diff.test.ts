import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";

describe("parseUnifiedDiff", () => {
  it("groups a unified diff by file and counts changed lines", () => {
    const diff = [
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,2 +1,2 @@",
      "-const one = 1;",
      "+const one = 2;",
      " const stable = true;",
      "diff --git a/src/two.ts b/src/two.ts",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -0,0 +1 @@",
      "+export const two = 2;",
    ].join("\n");

    const sections = parseUnifiedDiff(diff);

    expect(sections).toHaveLength(2);
    expect(
      sections.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    ).toEqual([
      { path: "src/one.ts", additions: 1, deletions: 1 },
      { path: "src/two.ts", additions: 1, deletions: 0 },
    ]);
    expect(sections[0]?.lines.at(-1)?.line).toBe(" const stable = true;");
  });

  it("uses the old path for a deleted file and the new path for an added file", () => {
    const diff = [
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ /dev/null",
      "-gone",
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
      "+new",
    ].join("\n");

    expect(parseUnifiedDiff(diff).map((section) => section.path)).toEqual(["old.ts", "new.ts"]);
  });

  it("keeps a nonstandard patch in one fallback section", () => {
    const sections = parseUnifiedDiff("@@ -1 +1 @@\n-old\n+new");

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ path: "Changes", additions: 1, deletions: 1 });
  });
});
