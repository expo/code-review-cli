import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONFIG_DIRNAME,
  loadReviewConfig,
  parseFrontmatter,
  stripJsonComments,
  stripTrailingCommas,
} from "../config/load.js";

test("parseFrontmatter: parses scalar keys + returns body without frontmatter", () => {
  const { data, body } = parseFrontmatter("---\nmodel: x\nalwaysRun: true\n---\n# Body\ntext");
  expect(data.model).toBe("x");
  expect(data.alwaysRun).toBe("true");
  expect(body).toBe("# Body\ntext");
});

test("parseFrontmatter: no frontmatter → empty data, full body", () => {
  const { data, body } = parseFrontmatter("# Just body");
  expect(data).toEqual({});
  expect(body).toBe("# Just body");
});

test("stripJsonComments: removes // and /* */ but not inside strings", () => {
  expect(stripJsonComments('{"a":1 // comment\n}')).not.toContain("comment");
  expect(stripJsonComments('{"a":1 /* c */}')).not.toContain("/*");
  expect(stripJsonComments('{"url":"http://x"}')).toContain("http://x");
});

test("stripTrailingCommas: removes trailing commas (JSONC parse regression)", () => {
  expect(JSON.parse(stripTrailingCommas('{"a":1,}'))).toEqual({ a: 1 });
  expect(JSON.parse(stripTrailingCommas("[1,2,]"))).toEqual([1, 2]);
  // A comma inside a string must be preserved.
  expect(stripTrailingCommas('{"s":"a,"}')).toBe('{"s":"a,"}');
});

test("parseFrontmatter: a flow list fills `lists`; the scalar `data` value is unchanged", () => {
  const { data, lists, body } = parseFrontmatter(
    `---\npaths: ["packages/a/**", 'docs/*.md', .changeset/*.md]\nmodel: x\n---\nBody`,
  );
  expect(lists.paths).toEqual(["packages/a/**", "docs/*.md", ".changeset/*.md"]);
  expect(data.paths).toBe(`["packages/a/**", 'docs/*.md', .changeset/*.md]`);
  expect(data.model).toBe("x");
  expect(lists.model).toBeUndefined();
  expect(body).toBe("Body");
});

test("parseFrontmatter: a block list collects `- item` lines until the next key", () => {
  const { data, lists } = parseFrontmatter(
    [
      "---",
      "paths:",
      '  - "packages/a/**"',
      "  # a comment inside the list",
      "",
      "  - packages/b/**",
      "alwaysRun: true",
      "---",
      "Body",
    ].join("\n"),
  );
  expect(lists.paths).toEqual(["packages/a/**", "packages/b/**"]);
  expect(data.alwaysRun).toBe("true");
  expect(lists.alwaysRun).toBeUndefined();
});

test("parseFrontmatter: an empty flow list and a bare `-` item are kept for validation", () => {
  expect(parseFrontmatter("---\npaths: []\n---\n").lists.paths).toEqual([]);
  expect(parseFrontmatter("---\npaths:\n  -\n---\n").lists.paths).toEqual([""]);
  expect(parseFrontmatter(`---\npaths: ["a/**",]\n---\n`).lists.paths).toEqual(["a/**"]);
});

test("parseFrontmatter: CRLF line endings parse every key", () => {
  const { data, lists, body } = parseFrontmatter(
    '---\r\nmodel: x\r\npaths:\r\n  - "a/**"\r\nalwaysRun: true\r\n---\r\nBody',
  );
  expect(data.model).toBe("x");
  expect(lists.paths).toEqual(["a/**"]);
  expect(data.alwaysRun).toBe("true");
  expect(body).toBe("Body");
});

test("parseFrontmatter: a scalar or an unterminated flow list is not a list", () => {
  expect(parseFrontmatter("---\npaths: packages/a/**\n---\n").lists.paths).toBeUndefined();
  expect(parseFrontmatter(`---\npaths: ["a/**]\n---\n`).lists.paths).toBeUndefined();
  expect(parseFrontmatter("---\npaths:\n---\n").lists.paths).toBeUndefined();
});

test("parseFrontmatter: list items keep what validation must name", () => {
  // Text after a closing quote keeps the quotes, so the entry cannot pass as a glob.
  expect(parseFrontmatter(`---\npaths: ["a/**" "b/**", 'c/**']\n---\n`).lists.paths).toEqual([
    `"a/**" "b/**"`,
    "c/**",
  ]);
  expect(parseFrontmatter('---\npaths:\n  - "a/**" x\n---\n').lists.paths).toEqual([`"a/**" x`]);
  // `-glob` is not a YAML list item; it stays in the list with its dash, not dropped.
  expect(parseFrontmatter("---\npaths:\n  - a/**\n  -b/**\n---\n").lists.paths).toEqual([
    "a/**",
    "-b/**",
  ]);
});

async function configDirWithAgent(
  agentMd: string,
  coordinatorMd = "Coordinator prompt.",
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-agent-paths-"));
  const dir = path.join(root, CONFIG_DIRNAME);
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await writeFile(path.join(dir, "config.jsonc"), "{}", "utf8");
  await writeFile(path.join(dir, "coordinator.md"), coordinatorMd, "utf8");
  await writeFile(path.join(dir, "agents", "ios.md"), agentMd, "utf8");
  await writeFile(path.join(dir, "agents", "plain.md"), "---\nmodel: x/y\n---\nPLAIN", "utf8");
  return root;
}

test("loadReviewConfig: front-matter `paths` loads onto the agent; no `paths` adds no key", async () => {
  const root = await configDirWithAgent('---\npaths: ["packages/ios/**", "**/*.swift"]\n---\nIOS');
  try {
    const config = await loadReviewConfig(root);
    const ios = config.agents.find((agent) => agent.id === "ios")!;
    const plain = config.agents.find((agent) => agent.id === "plain")!;
    expect(ios.paths).toEqual(["packages/ios/**", "**/*.swift"]);
    expect(ios.promptText).toBe("IOS");
    expect("paths" in plain).toBe(false);
    // A clean setup carries no warnings key, so its review-cache key is unchanged.
    expect("setupWarnings" in config).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A load error would be worse than a warning: in CI it stops every review in the
// repo, and nothing checks agent files before they merge.
test("loadReviewConfig: an invalid `paths` is a warning, and the agent reviews every change", async () => {
  const cases: Array<[string, string]> = [
    ["paths: packages/ios/**", "is not a list of globs"],
    ["paths: []", "is empty"],
    ['paths: ["packages/ios/**", ""]', 'entry 2 ("") is empty'],
    ['paths: ["/packages/ios/**"]', 'write "packages/ios/**"'],
    ['paths: ["./packages/ios/**"]', 'write "packages/ios/**"'],
    ['paths: ["packages/ios/"]', 'write "packages/ios/**"'],
    ['paths: ["!packages/ios/**"]', "negation"],
    ['paths:\n  - "packages/ios/**"  # iOS only', 'write "packages/ios/**" and move the comment'],
    ["paths:\n  - packages/ios/** # iOS only", 'write "packages/ios/**" and move the comment'],
    ['paths: ["packages/ios/**"]  # iOS only', "move the comment to its own line"],
    ['paths:\n  - "packages/ios/**" extra', "text after its closing quote"],
    ['paths: ["packages/ios/**" "packages/android/**"]', "separate entries with commas"],
    ["paths:\n  -packages/ios/**", 'write "- packages/ios/**"'],
    ['paths: ["packages/{ios,android}/**"]', "brace set"],
    ["paths: [packages/{ios,android}/**]", 'unmatched "{" or "}"'],
  ];
  for (const [line, expected] of cases) {
    const root = await configDirWithAgent(`---\n${line}\n---\nIOS`);
    try {
      const config = await loadReviewConfig(root);
      const ios = config.agents.find((agent) => agent.id === "ios")!;
      expect("paths" in ios, line).toBe(false);
      expect(config.setupWarnings, line).toHaveLength(1);
      const [warning] = config.setupWarnings!;
      expect(warning).toContain(path.join(CONFIG_DIRNAME, "agents", "ios.md"));
      expect(warning).toContain(expected);
      expect(warning).toContain("reviews every change");
      expect(warning).toContain("remove `paths`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("loadReviewConfig: braces without a comma stay literal and valid", async () => {
  const root = await configDirWithAgent('---\npaths: ["{{cookiecutter.slug}}/**"]\n---\nIOS');
  try {
    const config = await loadReviewConfig(root);
    expect(config.agents.find((agent) => agent.id === "ios")!.paths).toEqual([
      "{{cookiecutter.slug}}/**",
    ]);
    expect(config.setupWarnings).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadReviewConfig: frontmatter below the first line is a warning, and loads as before", async () => {
  const cases: Array<[string, string]> = [
    ["<!-- @ref LLP 0009#x -->\n", "move the comment below the closing `---`"],
    ["﻿", "without a byte-order mark"],
    ["\n", "delete the lines above the opening `---`"],
  ];
  for (const [lead, fix] of cases) {
    const root = await configDirWithAgent(
      `${lead}---\ndescription: iOS\nalwaysRun: true\n---\nIOS`,
      `${lead}---\nmodel: x/coordinator\n---\nCOORD`,
    );
    try {
      const config = await loadReviewConfig(root);
      const ios = config.agents.find((agent) => agent.id === "ios")!;
      // Unchanged behavior: the hidden keys still do not apply.
      expect(ios.alwaysRun).toBe(false);
      expect(ios.description).toBe("");
      expect(config.setupWarnings).toHaveLength(2);
      for (const file of ["coordinator.md", path.join("agents", "ios.md")]) {
        const warning = config.setupWarnings!.find((entry) =>
          entry.startsWith(path.join(CONFIG_DIRNAME, file)),
        );
        expect(warning, `${JSON.stringify(lead)} ${file}`).toContain(fix);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("loadReviewConfig: an HTML comment with no frontmatter after it is not a warning", async () => {
  const root = await configDirWithAgent("<!-- note -->\n# iOS\n\n---\n\nMore text.");
  try {
    expect((await loadReviewConfig(root)).setupWarnings).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadReviewConfig: a trailing comment that breaks a scalar value is a warning", async () => {
  const root = await configDirWithAgent(
    "---\nalwaysRun: true   # run on every PR\nmodel: x/y # pinned\ntemperature: 0.2 # low\n---\nIOS",
  );
  try {
    const config = await loadReviewConfig(root);
    const ios = config.agents.find((agent) => agent.id === "ios")!;
    expect(ios.alwaysRun).toBe(false);
    const warnings = config.setupWarnings ?? [];
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("`alwaysRun: true   # run on every PR`");
    expect(warnings[0]).toContain("so `alwaysRun` is off");
    expect(warnings[1]).toContain("not a valid model id");
    expect(warnings[2]).toContain("default temperature");
    for (const warning of warnings) {
      expect(warning).toContain("move the comment to its own line");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function configDirWithPolicy(policy: Record<string, unknown>): Promise<string> {
  const root = await configDirWithAgent("IOS");
  await writeFile(
    path.join(root, CONFIG_DIRNAME, "config.jsonc"),
    JSON.stringify({ policy }),
    "utf8",
  );
  return root;
}

test("loadReviewConfig: `minSeverity` sets the severity floor, and defaults to `design`", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, "design"],
    [{ minSeverity: "warning" }, "warning"],
  ];
  for (const [policy, expected] of cases) {
    const root = await configDirWithPolicy(policy);
    try {
      const config = await loadReviewConfig(root);
      expect(config.policy.minSeverity).toBe(expected);
      expect("setupWarnings" in config).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// Zod strips unknown keys, so dropping `includeSuggestions` from the schema would silently
// turn a repo's suggestions off.
test("loadReviewConfig: `includeSuggestions` loads as a floor, with a warning that names the fix", async () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ includeSuggestions: true }, "nit", 'Replace it with `"minSeverity": "nit"`'],
    [{ includeSuggestions: false }, "design", 'Replace it with `"minSeverity": "design"`'],
    [{ includeSuggestions: true, minSeverity: "warning" }, "warning", "has no effect"],
  ];
  for (const [policy, expected, fix] of cases) {
    const root = await configDirWithPolicy(policy);
    try {
      const config = await loadReviewConfig(root);
      expect(config.policy.minSeverity).toBe(expected);
      expect(config.setupWarnings).toHaveLength(1);
      const [warning] = config.setupWarnings!;
      expect(warning).toContain(path.join(CONFIG_DIRNAME, "config.jsonc"));
      expect(warning).toContain(fix);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
