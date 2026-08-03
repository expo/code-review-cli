// Regressions for the local-review findings on the feedback feature: root-only
// values must survive a NESTED scope load, and a stored `applied` flag is never
// a fact — it is recomputed under the current config.
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RoutingManifestSchema } from "../config/schema.js";
import { loadReviewConfig, loadScopeConfig, CONFIG_DIRNAME } from "../config/load.js";
import { feedbackApplied, feedbackNeedsRunSeam } from "../core/adjudicate.js";

async function writeConfigDir(
  dir: string,
  opts: { config: string; agents: Record<string, string> },
): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await writeFile(path.join(dir, "config.jsonc"), opts.config, "utf8");
  await writeFile(path.join(dir, "coordinator.md"), "Coordinator prompt.", "utf8");
  for (const [id, body] of Object.entries(opts.agents)) {
    await writeFile(path.join(dir, "agents", `${id}.md`), body, "utf8");
  }
}

const agent = (name: string): string => `---\ndescription: ${name} agent\n---\n${name} PROMPT`;

// The bug this pins: a nested scope's config is parsed with ScopeReviewConfigSchema,
// which rejects `feedback`/`stack`, so its own parse always carries the hardcoded
// defaults — loadScopeConfig must re-derive BOTH from the root, like auth and
// breakGlassMarker, or a nested scope silently runs the default policy.
test("loadScopeConfig: nested scope inherits the ROOT feedback and stack config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-feedback-root-"));
  await writeConfigDir(path.join(root, CONFIG_DIRNAME), {
    config: `{
      "feedback": { "mode": "adjudicate", "dismiss": "maintainers", "maxAdjudications": 3 },
      "stack": { "enabled": true, "maxDepth": 2 }
    }`,
    agents: { security: agent("security") },
  });
  await writeConfigDir(path.join(root, "apps", "api", CONFIG_DIRNAME), {
    config: "{}",
    agents: { style: agent("style") },
  });
  const manifest = RoutingManifestSchema.parse({
    scopes: [
      { name: "default", paths: ["**/*"], config: "." },
      { name: "api", paths: ["apps/api/**"], config: "apps/api" },
    ],
  });
  const rootConfig = await loadReviewConfig(root);
  const scoped = await loadScopeConfig(root, manifest.scopes[1]!, manifest, rootConfig);
  expect(scoped.feedback).toEqual(rootConfig.feedback);
  expect(scoped.feedback.mode).toBe("adjudicate");
  expect(scoped.feedback.dismiss).toBe("maintainers");
  expect(scoped.feedback.maxAdjudications).toBe(3);
  expect(scoped.stack).toEqual(rootConfig.stack);
  // The seam decision made from the scoped config now matches the root policy.
  expect(feedbackNeedsRunSeam(scoped.feedback)).toBe(true);
});

// The bug this pins: `applied: true` stored under an old config must not keep a
// finding hidden after `dismiss` is flipped back to "never" — the flag is a
// function of the CURRENT config, so recomputation must return false.
test("feedbackApplied: recomputation under dismiss:'never' un-applies a stored record", () => {
  const finding = {
    severity: "warning",
    category: "quality",
    file: "a.ts",
    line: 1,
    title: "T",
    rationale: "r",
  } as const;
  const record = {
    fp: "ab12",
    by: "someone",
    commentId: 1,
    maintainer: true,
    applied: true,
  } as const;
  const revoked = {
    mode: "annotate",
    match: "both",
    dismiss: "never",
    protectedCategories: [],
    maxAdjudications: 10,
  } as const;
  expect(feedbackApplied(finding, record, revoked)).toBe(false);
});
