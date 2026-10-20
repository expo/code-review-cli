import { test, expect } from "bun:test";

import { decodeGitPath, parseUnifiedDiff } from "../core/diff.js";

test("parses a normal text diff: path, status, patch, not binary", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;`;
  const [entry] = parseUnifiedDiff(diff);
  expect(entry!.path).toBe("src/a.ts");
  expect(entry!.status).toBe("M");
  expect(entry!.binary).toBe(false);
  expect(entry!.patch).toContain("+const y = 2;");
});

test("flags a binary-diff marker (the binary blind-spot regression)", () => {
  const diff = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000000..05ecf33bf8
Binary files /dev/null and b/assets/logo.png differ`;
  const [entry] = parseUnifiedDiff(diff);
  expect(entry!.path).toBe("assets/logo.png");
  expect(entry!.binary).toBe(true);
  expect(entry!.status).toBe("A");
});

test("derives added / deleted status", () => {
  const added = parseUnifiedDiff(
    `diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x`,
  )[0];
  expect(added!.status).toBe("A");
  const deleted = parseUnifiedDiff(
    `diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x`,
  )[0];
  expect(deleted!.status).toBe("D");
});

test("splits multiple files in order", () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
+b
diff --git a/c.ts b/c.ts
--- a/c.ts
+++ b/c.ts
@@ -1 +1 @@
-c
+d`;
  expect(parseUnifiedDiff(diff).map((e) => e.path)).toEqual(["a.ts", "c.ts"]);
});

test("decodes git's C-quoted paths (non-ASCII and special characters)", () => {
  // What git and GitHub print for `src/café.ts` with core.quotePath on (the default).
  const added = `diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ "b/src/caf\\303\\251.ts"
@@ -0,0 +1 @@
+x`;
  expect(parseUnifiedDiff(added)[0]).toMatchObject({ path: "src/café.ts", status: "A" });
  const deleted = `diff --git "a/docs/say \\"hi\\".md" "b/docs/say \\"hi\\".md"
deleted file mode 100644
index 1111111..0000000
--- "a/docs/say \\"hi\\".md"
+++ /dev/null
@@ -1 +0,0 @@
-x`;
  expect(parseUnifiedDiff(deleted)[0]).toMatchObject({ path: 'docs/say "hi".md', status: "D" });
});

test("a pure rename of a quoted path keeps its entry (path from the header)", () => {
  // No ---/+++ lines, so the path comes from the header; it used to drop the file.
  const diff = `diff --git "a/x/R\\303\\251sum\\303\\251.md" "b/y/R\\303\\251sum\\303\\251.md"
similarity index 100%
rename from "x/R\\303\\251sum\\303\\251.md"
rename to "y/R\\303\\251sum\\303\\251.md"
diff --git a/old/plain.md "b/new/caf\\303\\251.md"
similarity index 100%
rename from old/plain.md
rename to "new/caf\\303\\251.md"`;
  expect(parseUnifiedDiff(diff).map((entry) => [entry.path, entry.status])).toEqual([
    ["y/Résumé.md", "R"],
    ["new/café.md", "R"],
  ]);
});

test("decodeGitPath: bare paths are unchanged; escapes decode to bytes", () => {
  expect(decodeGitPath("src/a b.ts")).toBe("src/a b.ts");
  expect(decodeGitPath('"tab\\there"')).toBe("tab\there");
  expect(decodeGitPath('"back\\\\slash"')).toBe("back\\slash");
  expect(decodeGitPath('"\\346\\227\\245\\346\\234\\254.md"')).toBe("日本.md");
});
