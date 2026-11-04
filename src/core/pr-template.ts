import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { stripHiddenText } from "./prompts.js";

// The places GitHub looks for a pull request template, relative to the repository root.
const TEMPLATE_DIRS = ["", ".github", "docs"];
const TEMPLATE_EXT = "(md|markdown|txt)";
const TEMPLATE_NAME = new RegExp(`^pull_request_template(\\.${TEMPLATE_EXT})?$`, "i");
const TEMPLATE_FILE = new RegExp(`\\.${TEMPLATE_EXT}$`, "i");

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// @ref LLP 0004#prompt-assembly-and-sanitization [implements] — template comments come from the trusted root, never the PR head
/**
 * The hidden comments of the repository's pull request templates, keyed the way
 * `stripHiddenText` returns them. Authors often leave a template's guidance comments in
 * the PR body, so a matching comment is expected and is not reported as hidden text.
 *
 * Read from the trusted root only. A PR that could edit the template could copy its
 * own hidden text into it and make that text look expected.
 */
export async function readPullRequestTemplateComments(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const dir of TEMPLATE_DIRS) {
    for (const entry of await listDir(path.join(root, dir))) {
      if (!TEMPLATE_NAME.test(entry.name)) {
        continue;
      }
      const full = path.join(root, dir, entry.name);
      if (entry.isFile()) {
        files.push(full);
      } else if (entry.isDirectory()) {
        for (const inner of await listDir(full)) {
          if (inner.isFile() && TEMPLATE_FILE.test(inner.name)) {
            files.push(path.join(full, inner.name));
          }
        }
      }
    }
  }

  const comments = new Set<string>();
  for (const file of files) {
    for (const comment of stripHiddenText(await readFile(file, "utf8")).comments) {
      comments.add(comment);
    }
  }
  return [...comments];
}
