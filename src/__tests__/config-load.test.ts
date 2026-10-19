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

async function configDirWithAgent(agentMd: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-agent-paths-"));
  const dir = path.join(root, CONFIG_DIRNAME);
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await writeFile(path.join(dir, "config.jsonc"), "{}", "utf8");
  await writeFile(path.join(dir, "coordinator.md"), "Coordinator prompt.", "utf8");
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadReviewConfig: invalid `paths` fails once, naming the agent file and the fix", async () => {
  const cases: Array<[string, string]> = [
    ["paths: packages/ios/**", "must be a list"],
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
  ];
  for (const [line, expected] of cases) {
    const root = await configDirWithAgent(`---\n${line}\n---\nIOS`);
    try {
      const error = await loadReviewConfig(root).then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      expect(error?.message).toContain(path.join(CONFIG_DIRNAME, "agents", "ios.md"));
      expect(error?.message).toContain(expected);
      expect(error?.message).toContain("remove `paths`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
