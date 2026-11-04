import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readPullRequestTemplateComments } from "../core/pr-template.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ecr-pr-template-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("reads comments from every place GitHub looks for a template", async () => {
  // A .github template with no extension, as expo/expo has.
  await mkdir(path.join(root, ".github"));
  await writeFile(
    path.join(root, ".github", "PULL_REQUEST_TEMPLATE"),
    "# Why\n\n<!--\n  Describe the problem.\n-->\n",
  );
  // A root template, whatever the case of its name.
  await writeFile(path.join(root, "Pull_Request_Template.md"), "[//]: # (Fill this in)\n");
  // A directory of templates.
  const dir = path.join(root, "docs", "PULL_REQUEST_TEMPLATE");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "bug.md"), "<!-- Steps to reproduce -->");

  expect((await readPullRequestTemplateComments(root)).sort()).toEqual([
    "<!-- Describe the problem. -->",
    "<!-- Steps to reproduce -->",
    "[//]: # (Fill this in)",
  ]);
});

test("returns no comments when the repository has no template", async () => {
  await writeFile(path.join(root, "README.md"), "<!-- not a template -->");
  expect(await readPullRequestTemplateComments(root)).toEqual([]);
});
