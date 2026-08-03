import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkConfigRefs,
  citedPathsTouchedBy,
  discoverSetupDirs,
  findProseCitations,
  isCodeCitation,
  parseRefAnnotations,
  parseRefIgnores,
  reviewSetupRefNotes,
  slugifyHeading,
  suggestedRef,
} from "../core/config-refs.js";

const REF = "@ref";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-refs-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

/** A minimal setup dir: agents/ plus whatever the test adds. */
function setup(extra: Record<string, string>): Record<string, string> {
  return {
    ".expo-code-review/config.jsonc": "{}\n",
    ".expo-code-review/agents/security.md": "# Security\n",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test("parses refs from markdown comments and from // comments, with line numbers", () => {
  const md = `# Title\n\n<!-- ${REF} src/a.ts — the invariant -->\nprose\n<!-- ${REF} src/b.ts#foo [implements] -->\n`;
  expect(parseRefAnnotations(md, "agents/x.md")).toEqual([
    { file: "agents/x.md", line: 3, target: "src/a.ts" },
    { file: "agents/x.md", line: 5, target: "src/b.ts#foo" },
  ]);

  const jsonc = `{\n  // ${REF} src/c.ts — why\n  "a": 1\n}\n`;
  expect(parseRefAnnotations(jsonc, "config.jsonc")).toEqual([
    { file: "config.jsonc", line: 2, target: "src/c.ts" },
  ]);
});

test("@ref-ignore lists tokens that are prose, not citations", () => {
  const text = `<!-- ${REF}-ignore knex.raw() session.ts -->\n`;
  expect([...parseRefIgnores(text)].sort()).toEqual(["knex.raw()", "session.ts"]);
  // the ignore marker must not be collected as a ref itself
  expect(parseRefAnnotations(text, "a.md")).toEqual([]);
});

test("isCodeCitation separates paths from prose tokens", () => {
  for (const token of [
    "server/www/src/utils/session.ts",
    "session.ts",
    "src/entities/oauth/",
    ".github/workflows/**",
    "*PrivacyPolicy.ts",
  ]) {
    expect(isCodeCitation(token)).toBe(true);
  }
  for (const token of [
    "ecr ci",
    "label:<agent>",
    "knex.raw()",
    "openai/gpt-5.5",
    "**",
    "/",
    "critical",
    '{ "findings": [] }',
  ]) {
    expect(isCodeCitation(token)).toBe(false);
  }
});

test("prose citations skip fenced code blocks", () => {
  const text = "`a/b.ts` here\n\n```\n`c/d.ts` example\n```\n\n`e/f.ts` again\n";
  expect(findProseCitations(text).map((c) => c.token)).toEqual(["a/b.ts", "e/f.ts"]);
});

test("suggestedRef turns abbreviated and bare citations into suffix globs", () => {
  expect(suggestedRef("server/www/src/a.ts")).toBe("server/www/src/a.ts");
  expect(suggestedRef(".../config/MetricGroupCounter.kt")).toBe("glob:**/config/MetricGroupCounter.kt");
  expect(suggestedRef("session.ts")).toBe("glob:**/session.ts");
  expect(suggestedRef("*PrivacyPolicy.ts")).toBe("glob:**/*PrivacyPolicy.ts");
});

test("slugifyHeading matches GitHub anchors", () => {
  expect(slugifyHeading("The `@ref` Grammar")).toBe("the-ref-grammar");
  expect(slugifyHeading("No Line Numbers, Symbol Anchors")).toBe("no-line-numbers-symbol-anchors");
});

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

test("a ref to an existing file, dir, symbol, heading, and glob resolves", async () => {
  const root = await makeRepo(
    setup({
      "src/auth.ts": "export function verifySession() {}\n",
      "src/entities/oauth/index.ts": "export const x = 1;\n",
      "docs/DESIGN.md": "# Design\n\n## Session Rules\n\ntext\n",
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} src/auth.ts — the only session entry point -->\n` +
        `<!-- ${REF} src/auth.ts#verifySession -->\n` +
        `<!-- ${REF} src/entities/oauth/ -->\n` +
        `<!-- ${REF} docs/DESIGN.md#session-rules -->\n` +
        `<!-- ${REF} glob:src/**/*.ts -->\n`,
    }),
  );
  const report = await checkConfigRefs({ root });
  expect(report.problems).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.refs).toHaveLength(5);
  expect(report.citedPaths).toContain("src/auth.ts");
});

test("a ref to a moved file, a renamed symbol, or a missing heading is broken", async () => {
  const root = await makeRepo(
    setup({
      "src/auth.ts": "export function verifySession() {}\n",
      "docs/DESIGN.md": "# Design\n",
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} src/moved.ts — gone -->\n` +
        `<!-- ${REF} src/auth.ts#checkSession -->\n` +
        `<!-- ${REF} docs/DESIGN.md#session-rules -->\n`,
    }),
  );
  const report = await checkConfigRefs({ root });
  expect(report.ok).toBe(false);
  expect(report.problems.map((p) => [p.line, p.kind])).toEqual([
    [1, "broken-ref"],
    [2, "broken-ref"],
    [3, "broken-ref"],
  ]);
  expect(report.problems[0]!.problem).toContain("no such path");
  expect(report.problems[1]!.problem).toContain("no longer contains");
  expect(report.problems[2]!.problem).toContain("no heading");
});

test("line-number refs and citations are refused, in an annotation or in prose", async () => {
  const root = await makeRepo(
    setup({
      "src/auth.ts": "export function verifySession() {}\n",
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} src/auth.ts:42 — the check -->\n\nSee \`src/auth.ts:42-51\`.\n`,
    }),
  );
  const report = await checkConfigRefs({ root });
  expect(report.problems.every((p) => p.kind === "line-number-ref")).toBe(true);
  expect(report.problems).toHaveLength(2);
});

test("a ref may never escape the repository", async () => {
  const root = await makeRepo(
    setup({
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} ../outside/secrets.ts -->\n<!-- ${REF} /etc/passwd -->\n`,
    }),
  );
  const report = await checkConfigRefs({ root });
  expect(report.problems).toHaveLength(2);
  expect(report.problems[0]!.problem).toContain("escapes the repository");
  expect(report.problems[1]!.problem).toContain("absolute path");
});

test("an unannotated path citation fails, and @ref-ignore or an annotation clears it", async () => {
  const root = await makeRepo(
    setup({
      "src/auth.ts": "export const a = 1;\n",
      ".expo-code-review/agents/security.md": "Read `src/auth.ts` and `knex.raw()` before flagging.\n",
    }),
  );
  const before = await checkConfigRefs({ root });
  expect(before.problems).toHaveLength(1);
  expect(before.problems[0]!.kind).toBe("unannotated-citation");
  expect(before.problems[0]!.problem).toContain(`${REF} src/auth.ts`);

  const fixed = await makeRepo(
    setup({
      "src/auth.ts": "export const a = 1;\n",
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} src/auth.ts — session entry point -->\n` +
        `<!-- ${REF}-ignore knex.raw() -->\n` +
        "Read `src/auth.ts` and `knex.raw()` before flagging.\n",
    }),
  );
  expect((await checkConfigRefs({ root: fixed })).problems).toEqual([]);
});

test("extensionless citations count only when they name something real", async () => {
  const root = await makeRepo({
    "infrastructure/eas-build-worker/terraform/main.tf": "resource {}\n",
    "infrastructure/general-central/module/main.tf": "resource {}\n",
    "infrastructure/finops/main.tf": "resource {}\n",
    "infrastructure/.expo-code-review/config.jsonc": "{}\n",
    "infrastructure/.expo-code-review/agents/terraform-safety.md":
      "State reviewer for `general-central/{module,production}`, `finops`,\n" +
      "`eas-build-worker/terraform`, on `anthropic/claude-opus-5`.\n",
  });
  const report = await checkConfigRefs({ root });
  const tokens = report.problems.map((problem) => problem.problem);
  expect(tokens).toHaveLength(3);
  // the model id is shaped like a path and must never be flagged
  expect(tokens.some((problem) => problem.includes("claude-opus-5"))).toBe(false);
  // a scope-relative citation is taught its root-relative ref
  expect(
    tokens.some((problem) =>
      problem.includes(`${REF} infrastructure/eas-build-worker/terraform/ —`),
    ),
  ).toBe(true);
  expect(tokens.some((problem) => problem.includes(`${REF} infrastructure/finops/ —`))).toBe(true);
});

test("a scope-relative annotated ref is broken, and names the root-relative fix", async () => {
  const root = await makeRepo({
    "infrastructure/general-central/module/main.tf": "resource {}\n",
    "infrastructure/.expo-code-review/config.jsonc": "{}\n",
    "infrastructure/.expo-code-review/agents/terraform-safety.md":
      `<!-- ${REF} general-central/module/ — the module tree -->\n`,
  });
  const report = await checkConfigRefs({ root });
  expect(report.problems).toHaveLength(1);
  expect(report.problems[0]!.kind).toBe("broken-ref");
  expect(report.problems[0]!.problem).toContain("did you mean infrastructure/general-central/module");
});

// ---------------------------------------------------------------------------
// structural refs
// ---------------------------------------------------------------------------

test("routing: a scope with no setup dir, an unknown enforced agent, and a dead glob all fail", async () => {
  const root = await makeRepo(
    setup({
      "src/a.ts": "export const a = 1;\n",
      ".expo-code-review/routing.jsonc": JSON.stringify({
        defaults: { enforceAgents: ["security", "ghost"] },
        scopes: [
          { name: "default", paths: ["**/*"], config: "." },
          { name: "billing", paths: ["nope/**"], config: "packages/billing" },
        ],
      }),
    }),
  );
  const report = await checkConfigRefs({ root });
  const problems = report.problems.filter((p) => p.kind === "structural").map((p) => p.problem);
  expect(problems).toHaveLength(3);
  expect(problems.some((p) => p.includes('scope "billing" has no packages/billing/'))).toBe(true);
  expect(problems.some((p) => p.includes('agents/ghost.md'))).toBe(true);
  expect(problems.some((p) => p.includes("matches no file in the repo: nope/**"))).toBe(true);
});

test("scope setup dirs are swept too, and dot dirs (other worktrees) are not", async () => {
  const root = await makeRepo(
    setup({
      "packages/billing/.expo-code-review/agents/money.md": `<!-- ${REF} src/gone.ts -->\n`,
      ".claude/worktrees/other/.expo-code-review/agents/x.md": `<!-- ${REF} src/gone.ts -->\n`,
    }),
  );
  const dirs = await discoverSetupDirs(root);
  expect(dirs.map((d) => path.relative(root, d)).sort()).toEqual([
    ".expo-code-review",
    path.join("packages", "billing", ".expo-code-review"),
  ]);
  const report = await checkConfigRefs({ root });
  expect(report.problems).toHaveLength(1);
  expect(report.problems[0]!.file).toBe(
    path.join("packages", "billing", ".expo-code-review", "agents", "money.md"),
  );
});

test("one ref covers the prose form of the same citation", async () => {
  const root = await makeRepo(
    setup({
      "src/commands/review.ts": "export const a = 1;\n",
      "src/core/util.ts": "export function errorMessage() {}\n",
      "docs/deep/nested/Handler.kt": "class Handler\n",
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} glob:src/commands/*.ts — the command shape -->\n` +
        `<!-- ${REF} src/core/util.ts#errorMessage — the error path -->\n` +
        `<!-- ${REF} glob:**/Handler.kt — the handlers -->\n` +
        "Commands in `src/commands/*.ts` report via `src/core/util.ts`, like `.../nested/Handler.kt`.\n",
    }),
  );
  expect((await checkConfigRefs({ root })).problems).toEqual([]);
});

test("annotations inside a fenced block document the grammar and are not resolved", () => {
  const text = `<!-- ${REF} src/real.ts -->\n\n\`\`\`md\n<!-- ${REF} src/example.ts — how to write one -->\n\`\`\`\n`;
  expect(parseRefAnnotations(text, "agents/x.md").map((ref) => ref.target)).toEqual(["src/real.ts"]);
});

test("a target starting with < is a documented placeholder, not a citation", async () => {
  const root = await makeRepo(
    setup({
      ".expo-code-review/agents/security.md": `<!-- ${REF} <path/to/file.ts>#<symbol> — example -->\n`,
    }),
  );
  expect((await checkConfigRefs({ root })).problems).toEqual([]);
});

// ---------------------------------------------------------------------------
// review-side signal
// ---------------------------------------------------------------------------

test("reviewSetupRefNotes advises on broken refs and on cited code the PR changes", async () => {
  const root = await makeRepo(
    setup({
      "src/auth.ts": "export const a = 1;\n",
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} src/auth.ts — entry point -->\n<!-- ${REF} src/gone.ts — moved -->\n`,
    }),
  );
  const setupDir = path.join(root, ".expo-code-review");
  const notes = await reviewSetupRefNotes({
    root,
    setupDirs: [setupDir],
    changedFiles: ["src/auth.ts"],
  });
  expect(notes).toHaveLength(2);
  expect(notes[0]).toContain("no longer resolves");
  expect(notes[0]).toContain("ecr ref-check");
  expect(notes[1]).toContain("src/auth.ts");

  // An unannotated citation is a command-level failure, not review advice.
  const prose = await makeRepo(
    setup({
      "src/auth.ts": "export const a = 1;\n",
      ".expo-code-review/agents/security.md": "Read `src/auth.ts`.\n",
    }),
  );
  expect(
    await reviewSetupRefNotes({
      root: prose,
      setupDirs: [path.join(prose, ".expo-code-review")],
      changedFiles: [],
    }),
  ).toEqual([]);
});

test("setup problems are labelled by setup-dir position when the config lives outside the tree", async () => {
  const code = await makeRepo({ "src/auth.ts": "export const a = 1;\n" });
  const trustedBase = await makeRepo(
    setup({ ".expo-code-review/agents/security.md": `<!-- ${REF} src/gone.ts -->\n` }),
  );
  const report = await checkConfigRefs({
    root: code,
    setupDirs: [path.join(trustedBase, ".expo-code-review")],
  });
  expect(report.problems).toHaveLength(1);
  expect(report.problems[0]!.file).toBe(path.join(".expo-code-review", "agents", "security.md"));
});

test("citedPathsTouchedBy reports cited paths a PR changed, dirs included", async () => {
  const root = await makeRepo(
    setup({
      "src/auth.ts": "export const a = 1;\n",
      "src/entities/oauth/index.ts": "export const b = 2;\n",
      ".expo-code-review/agents/security.md":
        `<!-- ${REF} src/auth.ts — entry point -->\n<!-- ${REF} src/entities/oauth/ -->\n`,
    }),
  );
  const report = await checkConfigRefs({ root });
  expect(citedPathsTouchedBy(report, ["src/auth.ts", "README.md"])).toEqual(["src/auth.ts"]);
  expect(citedPathsTouchedBy(report, ["src/entities/oauth/token.ts"])).toEqual([
    "src/entities/oauth",
  ]);
  expect(citedPathsTouchedBy(report, ["README.md"])).toEqual([]);
});
