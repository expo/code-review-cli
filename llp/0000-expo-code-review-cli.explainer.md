# LLP 0000: Expo Code Review CLI: System Map and Invariants

**Type:** Explainer
**Status:** Active
**Systems:** Engine, Config, Security, Runtime, CLI, Sources, Reporters, Templates, CI
**Author:** Philippe Loulidi / Claude
**Date:** 2026-07-30
**Role:** Root
**Related:** [LLP 0001](0001-trust-model.principles.md), [LLP 0002](0002-review-engine-pipeline.explainer.md), [LLP 0003](0003-model-runtimes-and-credentials.explainer.md), [LLP 0004](0004-diff-noise-and-prompts.explainer.md), [LLP 0005](0005-verification-fingerprints-rendering.explainer.md), [LLP 0006](0006-config-schema-loading-routing.explainer.md), [LLP 0007](0007-cli-commands-and-ci.explainer.md), [LLP 0008](0008-sources-and-reporters.explainer.md), [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md)

This is the root map for `@expo/code-review-cli` (`ecr`). It records what the system does, how the subsystems divide, the invariants that hold across all of them, and where each concern's rationale lives. It is intentionally thin: every subsystem's detail belongs in the doc that owns it. Read this first, then follow the link for the part you care about.

## What ecr Does

`ecr` is a config-driven, multi-agent AI code reviewer engine. One run does this: diff a PR, filter out noise, fan the diff out to the configured reviewer agents (via OpenCode or the Claude Code CLI), coordinate and dedupe their findings, adversarially verify each finding against the actual source, then post exactly one advisory PR comment. The same engine runs locally as advisory output and in CI as a single updating comment [observed: README.md:5 "The same engine runs locally (advisory) and in CI (posts one PR comment)"; AGENTS.md:3-6].

The package was extracted from `expo/eas-cli` (initial commit `fed362b`, 2026-07-22 "Initial commit: @expo/code-review-cli"; reframed by commit `3cfbf3f` "Docs: reframe as standalone published package (extraction done)") into its own repo so it could be published to npm and iterated independently [observed: git log `fed362b`, `3cfbf3f`; ROADMAP.md:594-595]. Running the reviewer as the published npm package via `npx` rather than building from a checked-out PR ref is itself treated as a security property: in CI no PR-controlled code is ever built or executed [observed: README.md:484-485 "These workflows are comment-only (they never fail the PR's checks). The engine runs as the published package via `npx`, so no PR-controlled code is built."].

## Subsystem Map

The code divides by concern. Each directory maps to the doc that owns its rationale.

- `src/cli.ts` + `src/commands/` — the CLI surface: `init`, `review`, `ci`, `doctor`, `dismiss`, `setup-auth`, `verify-config`. Commands are thin: they supply a Source and render the result, and they never parse `config.jsonc`/`routing.jsonc` themselves — they call `loadReviewConfig`/`loadScopeConfig`/`loadRoutingManifest`/`loadAuthFromRoot` [observed: src/commands/doctor.ts:2-10,99,153,172-173; src/config/routing.ts:26 `loadRoutingManifest`]. Owned by [LLP 0007](0007-cli-commands-and-ci.explainer.md).
- `src/core/review.ts` — the review pipeline core, documented in its own header as "The invariant, mode-agnostic review core: filter → spawn each configured agent → coordinate → apply policy … the CLI commands are thin wrappers" precisely so the commands stay thin and both local and CI modes share one path [observed: src/core/review.ts:88-91]. Coordination lives in `src/core/coordinator.ts`. Owned by [LLP 0002](0002-review-engine-pipeline.explainer.md).
- `src/core/diff.ts`, `noise.ts`, `prompts.ts` — diff intake, noise filtering, and prompt assembly (untrusted PR text goes through `sanitizeUntrusted`/boundary markers) [observed: AGENTS.md:70-72]. Owned by [LLP 0004](0004-diff-noise-and-prompts.explainer.md).
- `src/core/opencode.ts`, `claude-code.ts`, `auth.ts`, `exec.ts` — the model runtimes (OpenCode server and Claude Code CLI), credential handling, and hardened subprocess spawning. Owned by [LLP 0003](0003-model-runtimes-and-credentials.explainer.md).
- `src/core/verify.ts`, `render.ts`, `schema.ts`, `suppress.ts` — finding verification against source, fingerprinting/suppression, and comment rendering. Owned by [LLP 0005](0005-verification-fingerprints-rendering.explainer.md).
- `src/config/` — the zod schema, loader, and monorepo `routing.ts` (assigns changed files to scopes, last-match-wins) [observed: AGENTS.md:16-18]. Owned by [LLP 0006](0006-config-schema-loading-routing.explainer.md).
- `src/sources/` (`local-git`, `github-pr`) + `src/reporters/` (`terminal`, `github`) — where the diff comes from and where findings go [observed: AGENTS.md:14-15; src/sources/, src/reporters/]. Owned by [LLP 0008](0008-sources-and-reporters.explainer.md).
- `templates/` + the scaffolded CI workflow — the files `ecr init` writes into an adopting repo; they define adopter-facing behavior and must stay in sync with the code [observed: AGENTS.md:19-20]. Owned by [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md).
- The trust model spans all of the above and is stated as principles in [LLP 0001](0001-trust-model.principles.md).

## Cross-Cutting Invariants

These hold repo-wide. Each is owned in detail by one doc; break any of them and the security or honesty story fails.

1. **Trusted base-commit config.** Review policy and executable reviewer config (`config.jsonc`, `routing.jsonc`, prompts, models, auth/`tokenEnv` mapping) load only from the PR's immutable base commit; the PR head is untrusted data used only for diff/source content and finding verification [observed: commit `601b19a` "Trusted base-commit configuration by default; isolate the runtime from PR-head config"; PLAN-trusted-base-config.md]. Owned by [LLP 0001](0001-trust-model.principles.md) / [LLP 0006](0006-config-schema-loading-routing.explainer.md).
2. **Single-source `tokenEnv`.** `auth.tokenEnv` is honored in exactly one place (root config or `routing.jsonc` `defaults.auth`), enforced twice: schema-level (scope configs reject `auth`/`breakGlass`) and CI-guard level (`verify-config` sweeps every config file) [observed: AGENTS.md:51-53; src/core/auth.ts:45,206 `FORBIDDEN_TOKEN_ENVS`]. Owned by [LLP 0006](0006-config-schema-loading-routing.explainer.md).
3. **A failed run never reads as Approve, and `ecr ci` never fails checks.** A failed, partial, or timed-out run must never render as a clean "Approve"; `ci` is comment-only and non-blocking [observed: src/commands/ci.ts:60 "non-blocking (a reviewer failure never fails the PR's checks)"; AGENTS.md:50]. Owned by [LLP 0007](0007-cli-commands-and-ci.explainer.md).
4. **Critical/secrets findings are never silently suppressed.** A critical- or secrets-severity finding can never be silently dropped by any mechanism except the explicit `/skip-review` marker; all other suppression is a display filter, never a review skip [observed: src/core/suppress.ts:21-23,39-43 (critical/secrets findings are never dropped by the inline-ignore backstop)]. Owned by [LLP 0005](0005-verification-fingerprints-rendering.explainer.md).
5. **Read-only agents.** Reviewer agents run with read-only tools only (read/grep/glob/list for OpenCode; Read/Grep/Glob for Claude Code passes) — never Bash/Edit/Write/WebFetch/WebSearch [observed: src/core/claude-code.ts:80-85 `READ_TOOL_MAP`/`ALL_READ_TOOLS`]. Owned by [LLP 0003](0003-model-runtimes-and-credentials.explainer.md).
6. **Stateless runs.** Prior comments, findings, and dismissal state are never fed back into review agents; every run is stateless over (diff + repo + PR title/body) [observed: src/core/prompts.ts:132-174 (the reviewer task is built only from the current diff, not prior findings); src/commands/dismiss.ts:1 (dismissal is a display-only mutation that never re-runs the review); src/core/render.ts:144]. Owned by [LLP 0002](0002-review-engine-pipeline.explainer.md).
7. **Coverage gaps are never silent.** A coverage gap (timeout, filtered file, un-reducible pass) is always reported [observed: src/core/coordinator.ts:13,34 `coverageNotes`/flag reduced coverage]. Owned by [LLP 0002](0002-review-engine-pipeline.explainer.md).
8. **Published engine in CI.** The engine runs as the published npm package via `npx` in CI, so no PR-controlled code is built or executed [observed: README.md:484-485]. Owned by [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md).

Underpinning all eight: PR content (diffs, paths, titles, in-repo config) is untrusted, and model output is untrusted — schema-validate it and trust `file`/`line`/`evidence` only after verification [observed: AGENTS.md:70-74]. `evidencePresence` confines its read to the review tree via `pathInside`, blocking absolute/`..` reads of host secrets [observed: src/core/verify.ts:71-87], and `git`/`gh` resolve to trusted absolute paths before every spawn [observed: src/core/exec.ts:286 `resolveTrustedTool`].

## History and Design Culture

The history (66 commits in this checkout, 2026-07-22 → 2026-07-30, extracted from `expo/eas-cli`) shows a project that started as a working reviewer and spent almost all of its later energy on two axes: (1) never silently drop or mislead, and (2) closing the trust boundary between PR-controlled content and the credentialed reviewer process — prompt injection, config injection, runtime/plugin injection, path traversal, and bare-name spawn hijack [observed: git log, 2026-07-22..2026-07-30].

Two cultural facts matter for anyone reading the code:

- **Dogfooding.** The repo runs its own reviewer against its own PRs as a first-class practice. Several load-bearing security fixes were reactive, found by the tool reviewing its own PRs or by a follow-up audit, not designed in from the start — commit `04a38e3` ("Harden untrusted-tree trust boundary: address AI review + security audit") shipped a cluster of fixes three days after `601b19a`'s initial trusted-base-config landing (2026-07-26 → 2026-07-29) [observed: commit `04a38e3`].
- **Decisions get revisited on measurement.** The quote-grounding hard-drop rule was shipped, measured against ~13 real PRs, and softened (not reversed) on 2026-07-23: it still keeps quote-grounding but switched to a fuzzy match after the hard drop killed a confirmed real bug. Read ROADMAP's "Recently shipped" as a log of actual course-corrections, not just additions [observed: ROADMAP.md:719-727]. In the same spirit, README claims about which providers/auth modes work should be verified against current code rather than trusted from prose — the Anthropic-subscription-via-OpenCode path never actually ran in CI: OpenCode has no Anthropic OAuth support, so it silently substituted its free gateway model [observed: ROADMAP.md:613-616].

## Where to Look

Start here, then follow the owning doc.

| Question | Doc | Key files |
| --- | --- | --- |
| Why is PR content untrusted, and what is the threat model? | [LLP 0001](0001-trust-model.principles.md) | `PLAN-trusted-base-config.md`, `src/core/scrub.ts`, `src/core/exec.ts` |
| How does one review run flow, budget, and fall back? | [LLP 0002](0002-review-engine-pipeline.explainer.md) | `src/core/review.ts`, `src/core/coordinator.ts` |
| How do the model runtimes, subprocesses, and credentials work? | [LLP 0003](0003-model-runtimes-and-credentials.explainer.md) | `src/core/opencode.ts`, `claude-code.ts`, `auth.ts`, `exec.ts` |
| How is the diff filtered and the prompt built? | [LLP 0004](0004-diff-noise-and-prompts.explainer.md) | `src/core/diff.ts`, `noise.ts`, `prompts.ts` |
| How are findings verified, deduped, and rendered? | [LLP 0005](0005-verification-fingerprints-rendering.explainer.md) | `src/core/verify.ts`, `render.ts`, `suppress.ts`, `schema.ts` |
| How does config load, and how does monorepo routing pick scopes? | [LLP 0006](0006-config-schema-loading-routing.explainer.md) | `src/config/schema.ts`, `load.ts`, `routing.ts` |
| What do the CLI commands do, and how does CI orchestrate them? | [LLP 0007](0007-cli-commands-and-ci.explainer.md) | `src/cli.ts`, `src/commands/*` |
| Where does the diff come from and where do findings go? | [LLP 0008](0008-sources-and-reporters.explainer.md) | `src/sources/*`, `src/reporters/*` |
| What does `ecr init` scaffold into an adopting repo? | [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md) | `templates/`, scaffolded CI workflow |

Non-doc sources of truth: `AGENTS.md` holds the working conventions (import style, error handling, the `opencode-ai`/`@opencode-ai/sdk` pinning rule, security invariants); `ROADMAP.md` lists open and deferred items — incremental review, inline PR comments, result-level caching, and a Codex token rotator among them are still open and must not be assumed implemented [observed: ROADMAP.md]; and `templates/` is the adopter-facing contract, so treat it as behavior, not sample text.
