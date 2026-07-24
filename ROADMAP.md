# expo-code-review — roadmap / next steps

Working notes for the experimental reviewer, now published as
`@expo/code-review-cli` and extracted into its own repo (it was incubated inside
`expo/eas-cli`, which is why much of the history below references that repo and
PR #4022). Items are roughly ordered by priority.

## Merge boundary — phase 1 vs follow-ups

PR #4022 lands a self-contained **phase 1** (opt-in, comment-only, non-blocking)
that is meant to merge and then iterate in follow-up PRs. What's **in** phase 1 is
under "Recently shipped" below. The highest-value work **deferred to follow-up
PRs** (do these first, in this order):

1. **Incremental / delta review** — review only what changed since the last review
   (persistent per-file-version state). Biggest speed + cost + reliability win on
   re-pushes; the last remaining lever for the monster-PR case. See §5.
2. **Cross-cutting pass parallelization / bounding** — it's the serial long-pole on
   large PRs (one pass over every changed file). Chunk it by package/proximity.
3. ✅ **Transient-error retry with backoff** *(shipped 2026-07-23, #3.)* A non-timeout,
   non-parse API error (one-off 429/5xx/network) used to drop that pass with no retry.
   Now retried with bounded backoff via `isTransientApiError` (excludes
   `AgentTimeoutError`), distinct from the timeout→subdivide and parse→retry paths.
4. **Close the config/code injection vector (security)** — the auto-workflow builds
   + loads config from the PR merge ref, so a same-repo PR can rewrite the reviewer's
   prompts/config/code and it runs with secrets. Fix: build + load config from the
   trusted base ref (diff still via `gh`), like the `/review` command workflow — or
   switch to the published package via `npx`. Deferred only because the reviewer
   isn't on `main` yet (nothing to build from base until this merges). See §3.9.
5. **Inline PR comments** (§1).

## Recently shipped

- **Bounded per-scope passes budget (shipped 2026-07-23)** — active scopes review
  SEQUENTIALLY in one `ecr ci`, so the old per-scope budget
  (`max(10m, floor(32m / N))`) let 4+ scopes spend 40m+ of pass time alone,
  unbounded as scopes grow, blowing past the 32m the CI job timeout was sized
  around. The total is now bounded: a new `budget` key in `routing.jsonc`
  (`totalPassesMinutes` default 32, `minScopeMinutes` default 5; zod defaults, so
  absent = today's totals) is divided across active scopes by a pure
  `scopePassesBudgetMs(total, min, active)` (even split, clamped up to the floor).
  When the floor would make `active × perScope` overshoot the total, the floor is
  kept but `ecr ci` warns loudly (naming the overshoot + expected wall-clock) and
  `ecr doctor` flags the worst case (`scopes.length × floor` vs total). Template +
  README document the knob.
- **`--config-dir`/`ECR_CONFIG_DIR` fully composes with routing (shipped
  2026-07-23)** — the escape hatch previously half-composed: `loadReviewConfig`/
  `hasConfig` honored the override but `loadRoutingManifest` and scope loading did
  not, so the root config came from the override dir while `routing.jsonc` and
  scope configs came from the default tree. The override now designates an
  alternate ROOT config dir: `loadRoutingManifest(root, { configDir })` reads
  `routing.jsonc` from the same resolved dir as `config.jsonc` (`resolveConfigDir`).
  Scope `config` paths stay repo-root-relative (an override must not invent a
  parallel scope universe), and each scope's `.expo-code-review` dir name is
  unchanged — only the ROOT artifacts follow the override. `ecr ci` gained a
  `--config-dir` flag (mirroring `ecr review`) threaded through the legacy and
  routed config loads; `doctor` prints an ℹ line naming the resolved root dir when
  the override is active; `verify-config` notes the override (its repo-wide
  security sweep is unchanged). With no override, resolution is byte-identical
  (backcompat).
- **Full workflow template set + Opus rosters + SHA-pinned actions (shipped
  2026-07-23)** — `templates/` shipped only the auto (`pull_request`) `workflow.yml`,
  so both production adopters (eas-cli, universe) hand-wrote the `/review` command
  workflow, the `/dismiss` workflow, and the always-run run-log upload. Those are now
  templates: `command.yml` (maintainer-gated `issue_comment` `/review`, base-ref-only
  checkout, `ecr verify-config` guard, bash-array `--agents`/`--route`) and
  `dismiss.yml` (`/dismiss`//`/undismiss`, sanitized id/reason parse, no model secret),
  both scaffolded by `ecr init` as `expo-code-review-command.yml` /
  `expo-code-review-dismiss.yml`. `workflow.yml` gained the `always()` "Upload review
  run log" artifact step so the otherwise-ephemeral `.runs/reviews.jsonl` survives a CI
  run. Every `uses:` across the three templates is now pinned by full commit SHA with a
  version comment (checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1). And the
  templates match the production rosters' model provisioning: `coordinator.md` and
  `agents/security.md` now pin `anthropic/claude-opus-4-8` (were haiku / unpinned).
- **Canonical `ecr verify-config` CI guard (shipped 2026-07-23)** — the pre-review
  tokenEnv guard, previously duplicated across adopter workflows as brittle bash/awk
  JSONC text-scraping at different robustness tiers, is now ONE command shipped by the
  CLI. It walks every `.expo-code-review/config.jsonc|config.json` + `routing.jsonc`
  in the checkout (plain recursive walk skipping node_modules/.git, so a staged
  unreferenced config can't hide from git's index), parses each with the engine's REAL
  comment-aware JSONC parser (never regex), and refuses (exit 1, `::error::` on stderr)
  when `auth.tokenEnv`/`defaults.auth.tokenEnv` appears more than once, in a non-root
  file, or (with `--expected`/`ECR_EXPECTED_TOKEN_ENV`) differs from the expected name
  or is absent; when a non-root config declares `auth`/`breakGlass`/`commentTag`
  (root-locked, checked WITHOUT trusting the manifest references the file); or when any
  file fails to parse (fail-closed). `--json` emits `{ok, findings:[{file, problem}]}`.
  The workflow template replaces its entire awk guard block with
  `npx ... ecr verify-config` (setup-node moved before it; running the PUBLISHED
  package via npx is safe pre-review since no PR code is built), and this repo's own
  self-review workflow runs `verify-config` from source. Layer 2 to the runtime
  `ECR_EXPECTED_TOKEN_ENV` lock (layer 1), so guard/loader drift still fails safe.
- **Manual `/review` bypasses the trigger gate (shipped 2026-07-23)** — an explicit
  maintainer invocation (`ecr ci --force`, or a `/review` comment command detected via
  `GITHUB_EVENT_NAME=issue_comment`) now reviews even when the trigger policy would skip
  (label trigger unmet, or the `ai-review:skip` label set), so the manual escape hatch
  is no longer silently defeated (eyes reaction then nothing). It still calls
  `shouldReview` and logs a stderr notice naming what it overrode. The bypass affects
  ONLY the trigger gate (`shouldBypassTriggerGate`/`passesTriggerGate` in `ci.ts`,
  applied identically in the legacy and routed paths) — break-glass and the auth lock
  still apply.
- **Monorepo routing manifest (shipped 2026-07-23)** — an optional infra-owned
  `.expo-code-review/routing.jsonc` maps ordered path globs to scopes, each pointing
  at its own `.expo-code-review/` config dir. One `ecr ci` process fans out
  INTERNALLY: it reads the PR's changed files once, assigns each to exactly one scope
  (last-match-wins), reviews each active scope over only its files, then renders ONE
  comment (aggregated `single` by default, or `per-scope`). Single-writer/single-
  process, so there's no comment/check race and one shared `gh` diff + link-context
  across scopes (rate-limit hygiene). Security: `auth`/`tokenEnv` is locked to the
  root (rejected at the Zod level in scope configs + the widened repo-wide CI guard
  that also asserts `commentTag` uniqueness); `defaults.enforceAgents` inject a
  non-overridable roster (e.g. `security`) into every scope; scope-namespaced
  fingerprints keep cross-scope dismissals from colliding, and the default scope
  keeps the root marker so existing dismissal state carries over. Backcompat is
  free: no `routing.jsonc` ⇒ today's exact single-config behavior. New surface:
  `ecr init --monorepo`/`--scope <dir>`, `ecr review --scope`/`--config-dir`
  (+`ECR_CONFIG_DIR`), `ecr ci --scopes`/`--comment`, `ecr doctor --list-scopes`.
  *Deferred:* per-scope GitHub check runs; auto-spilling an oversized aggregate
  comment into per-scope comments (we truncate with a "+N more" note instead);
  CLI-side `ai-review:scope:<name>` label parsing (the adopting repo's workflow maps
  labels → `--scopes`, as it already does for `--agents`).
- **Follow-up batch (2026-07-23, PRs #2–#7)** — first round of post-extraction
  low-hanging-fruit hardening:
  - **Transient-error retry with backoff (#3)** — a one-off 429/5xx/network error on
    a pass is now retried with bounded backoff (2s→8s) instead of dropping the whole
    pass; classified by `isTransientApiError`, which excludes `AgentTimeoutError`
    (timeouts still abandon). Closes reliability/merge-boundary follow-up #3 below.
  - **Fail-fast provider-auth check (#4)** — `checkProviderAuth` (shared by
    `prepareAuth` + `doctor`) fails fast with one clear message before the run when
    the configured provider has no credential, instead of surfacing as N failed
    passes mid-run. Closes the "fail-fast provider-auth check" item under Model
    selection below.
  - **Auth failures collapse to one note (#5)** — a rejected credential (401/403)
    hitting every pass now reports a single actionable coverage note (`isAuthError`)
    instead of N generic failures. Closes the UX "auth-shaped errors → one message" item.
  - **`--staged` + `--base`/`--head` rejected (#2)** — was silently ignored; now a
    clear error. Closes the UX-minor `--staged`/`--base` warning item.
  - **Usage totals surfaced to CI/terminal (#6)** — token/cache/cost totals are
    printed as a one-line summary via progress, so prompt-cache reuse is visible in
    CI (where `.runs/reviews.jsonl` is ephemeral). Closes the §4.1 follow-up.
  - **Config-driven trigger policy + skip fix (#7)** — new `review.trigger`
    (`"all"` default | `"label"`) in `config.jsonc`; `ecr ci` self-gates via
    `shouldReview()`, honoring the write-gated `ai-review:skip` label. Fixed the
    workflow `if:` gate: the old `contains(join(labels), 'ai-review')` matched
    `ai-review:skip` as a substring (skip didn't skip) — now an exact array-form
    match, as an optional coarse opt-out on top of the config policy. Template +
    workflow kept in sync.
- **Never-drop-work on timeout (2026-07-22)** — a hard-timed-out chunk is now
  subdivided (halved recursively down to a single file) and re-reviewed instead of
  dropped; a single file that still won't converge gets a fast no-tools fallback
  over its inlined diff; only a genuinely un-reducible pass reports a coverage gap,
  never silently. Plus a tool-call cap (catches an agent that wanders instead of
  converging) and a global 32m passes budget. See §3 guarantees 1/2/5.
- Auto-discovered agents from `.expo-code-review/agents/*.md` + frontmatter.
- Adaptive-hybrid chunking (per-chunk + cross-cutting pass), chunk retry.
- LLM router (`--route`) and `/review` comment command.
- Noise filtering (lockfiles, generated markers, repo `additionalIgnores`).
- **Comment/label split** — `/review[ all|<agents>]` comments are now purely
  one-shot (imperative "review now", no config side effect); continuous review is
  configured by **labels** (declarative, visible, UI-toggleable): `ai-review`
  (router), `ai-review:all`, `ai-review:<agent>` (scoped to auto-discovered
  agents), `ai-review:skip` (opt-out). The auto workflow resolves `--agents`/
  `--route` from the labels; `/review-once` retired (all comments are one-shot).
- **Binary-diff blind-spot fix** — the parser now flags `Binary files … differ`
  entries and noise-filters them instead of handing agents an empty patch; and
  `noise.ts` no longer stashes a literal NUL byte as a glob sentinel (which had
  made git classify that source file as binary, hiding it from every reviewer).
- **Command-workflow hardening** — `expo-code-review-command.yml` no longer
  `gh pr checkout`s the PR head; it builds/runs only the trusted base ref. See
  "Reliability & security" below for the residual work.
- **Failure-path hardening (audit 2026-07-22)** — a failed/timed-out run never
  renders as a clean "Approve"; the coordinator has its own 5-min cap +
  soft-landing and a deterministic local-merge fallback (a coordinator hiccup no
  longer discards all findings); CI always posts a terminal state on failure;
  coverage notes now include filtered (binary/generated/ignored) files; the
  per-task retry explosion (up to ~9 model runs/task) was removed.
- **Cross-cutting collapsed to ONE combined pass** (was one per agent — 3
  redundant full-diff passes), the biggest large-PR latency win.
- **Cross-file pass no longer wanders the whole repo** — the collapsed pass ran
  under an *undefined* agent id, so OpenCode fell back to a default agent with
  full tools and it crawled unrelated packages until its 15-min cap (contributing
  nothing). Now defined as a real agent with a restricted tool set (`read`+`grep`,
  no `glob`/`list` crawling), so it converges instead of burning its budget.
- **Speed knobs** — longest-processing-time-first task scheduling;
  `concurrency` 4→6; CI job timeout 20→30 min (so the
  worst-case internal cap chain fits with headroom).
- **Inlined chunk diffs** — the reviewer task now embeds the assigned files' diffs
  (fenced as untrusted) instead of making the agent `read` each patch file, cutting
  per-pass tool round-trips. (Other files + cross-cutting still read on demand.)
- **Extended caps** — chunk 8→15m, cross-cutting 15→25m, coordinator 5→10m, CI job
  30→50m (kept the invariant: worst-case serial chain < job timeout). Gives
  slow-but-progressing passes room to converge instead of finalizing partial;
  cost is longer max runs + more tokens. Still model-generation-bound on the
  largest PRs — see §3 size guard / faster-model levers.
- **Generation-marker false-filter fix** — the noise filter matched generation
  markers (`@generated`, `do not edit`, …) anywhere in the first 40 added lines /
  4 KB, so hand-written files that merely *mention* those strings were wrongly
  skipped — including `noise.ts` itself (it lists them as `DEFAULT_MARKERS`) and a
  template comment. Now only the first few lines (a real header) count. Filtering
  on the #4022 diff dropped from 3 files → 1 (just `yarn.lock`).
- **`init` error handling** — wrapped in try/catch with a clean stderr message +
  exit code, matching the other commands (was the one command that could crash raw).
- **Chunk-size retune** — `maxChangedLines` 1500→1000. On the 51-file self-PR the
  reasoning-heavy `correctness` agent was the lone straggler at 15m with 1500-line
  chunks; smaller/more chunks (each finishing faster, run in parallel) reduce
  per-pass generation time. Reverses the earlier 1000→1500 bump.
  - *Observation to watch:* on that run the Haiku coordinator also ran ~10m (near
    its cap) — likely a large findings payload. If it recurs, trim the coordinator
    input (dedupe/cap findings before consolidation) or revisit its model.

## 1. Post a real PR review with inline comments (not one bottom comment)

Today the reporter posts a single consolidated issue comment. Move to a formal
review (`POST /pulls/{n}/reviews`) so findings land on the diff where the reader
is — matching what the Claude GitHub bot does.

Design:
- `event: COMMENT` (never `REQUEST_CHANGES`/`APPROVE`) to stay non-blocking in
  phase 1.
- Review **body** carries `decision` + `summary` + any finding whose `file:line`
  is not part of the diff (GitHub rejects inline comments off the diff). This is
  also the home for cross-cutting findings (e.g. a CI/workflow supply-chain
  issue that reasons across files).
- Findings whose `file:line` IS in the diff become inline comments, each with an
  embedded per-comment fingerprint (`<!-- ecr-fp:… -->`) so re-runs update in
  place instead of duplicating — same idea as today's single-comment fingerprint,
  applied per thread.
- Graceful fallback: any finding that fails to anchor inline drops into the body
  list rather than erroring the whole post.
- Keep the existing single-comment reporter as a fallback path / for hosts
  without a PR context (local runs already print, don't post).

Open question: dedup/cleanup of stale inline threads across pushes (resolve vs.
leave). The bot leaves them; simplest is to leave + update-by-fingerprint.

## 2. Unblocked integration (institutional context)

Prior research (see conversation + memory). The `unblocked` MCP/CLI exposes:
`context_get_rules` (structured repo rules w/ severity/task/paths),
`context_research` (why/who/when synthesis), `context_get_urls`.

- **Mode A (recommended first step, low-risk):** at review start, call
  `context_get_rules` for the repo and inject the returned rules into the
  `shared.md` / consistency-agent prompt as additional, authoritative
  conventions. Cheap, deterministic, directly improves the `consistency` agent.
- **Mode B (later):** give agents a research tool (wire `context_research` as an
  OpenCode tool) so they can pull the *why* behind a changed area on demand.
  More powerful, but adds latency + nondeterminism and a network dependency in
  CI — gate behind config and a timeout.
- Prereq: Unblocked auth in CI. Interactive-auth MCP servers may be absent in
  headless runs; needs a service token or a documented skip.

## 3. Reliability & security — "never hang / never silently fail"

Motivating incident: on the 49-file self-PR the review step ran ~28 min and was
killed. Root cause (confirmed from the run log, NOT rate-limiting): the 4 chunk
passes and two of the three cross-cutting passes completed fine; the single
`correctness [cross-file]` pass never converged. `buildCrossCuttingTask` lists
all changed files and lets the agent "read the surrounding source as needed" with
`read`/`grep`/`glob`/`list` over the whole repo, so on a 49-file diff it wandered
the entire monorepo (even unrelated packages) and could not emit its JSON within
the 8-min per-attempt cap. **Retry-on-timeout then made it 3× worse**: each retry
restarts the same unbounded wander (8 min × 3 = 24 min on that one task). There is
also **no global wall-clock budget**, so nothing bounded the total.

Guarantees (priority order; ✅ = shipped):

1. ✅ **Never silently drop work on timeout (subdivide-on-timeout).** *(Shipped
   2026-07-22.)* This supersedes the earlier "don't retry on timeout" rule, which
   only avoided compounding a non-convergent run but left the chunk's work dropped
   and merely reported as a gap — which is not acceptable for a review tool. Now a
   hard-timed-out chunk is **split in half and the halves re-reviewed** (recursively,
   down to a single file); a single file that still won't converge gets a fast
   **no-tools fallback** over its inlined diff; only if that can't finish inside the
   budget is a coverage gap reported (and it is always reported). See
   `runGrowableQueue` + the timeout branch in `review.ts`. Motivation: the auto-review
   of our own PR still dropped `correctness [4/7]` even after the finalize soft-landing.
   *(The per-task 3× retry wrapper stays removed; promptAndParse's internal parse
   retries are unchanged.)*
2. ✅ **Tool-call cap.** *(Shipped 2026-07-22.)* A pass that makes too many
   `read`/`grep` calls without converging is wandering; the cap (chunk 50,
   cross-cutting 120) trips the same soft-landing as the time cap. This attacks the
   root cause (roaming) directly — the cheap, self-contained version of Greptile's
   pre-indexed retrieval, without an index or an external dependency.
3. ✅ **Bound the cross-cutting pass** — collapsed to one combined pass and
   tightened its prompt to stay within the changed files.
4. ✅ **Always post a result** — a failed run reports "could not complete"; CI
   posts a terminal state on any failure; the coordinator has a deterministic
   fallback so its failure can't discard findings; and a failed/timed-out run
   never renders as a clean "Approve".
5. ✅ **Global time budget.** *(Shipped 2026-07-22.)* `PASSES_BUDGET_MS` (32m) is a
   hard wall-clock ceiling for all passes incl. subdivision/fallback waves: past it,
   a timed-out pass is reported as a gap rather than broken down further. Sits under
   per-task caps (chunk 15m, cross-cutting 25m, coordinator 10m) and the CI job cap
   (`timeout-minutes: 60`, the one hard-kill with no soft-landing).
6. ✅ **Size guard / degraded mode.** *(Largely addressed by #1.)* Subdivide-on-timeout
   is a *reactive* size guard: an oversized/dense chunk that can't converge is split
   until it does, rather than skipped. A *proactive* up-front "diff too large → review
   only the highest-signal subset" ceiling is still possible but no longer needed to
   prevent drops. The bigger remaining lever is **incremental review** (only review
   the delta since the last review, CodeRabbit-style) — see §5.
7. ✅ **Bound the coordinator** — 10-min cap + soft-landing + deterministic fallback;
   its `truncated` status now flows to a coverage note.
8. ✅ **Concurrency** default raised 4→6 (quality-neutral within rate limits).
9. **Publish + run via `npx` (both workflows).** The `init` template already runs
   the *published* package via `npx` (only the diff is PR-controlled) — strictly
   safer than our in-repo workflows that `yarn build` from source. Once published,
   switch both in-repo workflows to the published binary and stop building from a
   checkout. Also revisit the `pull_request` auto-workflow: it builds/runs the PR
   merge ref; fork PRs are protected (GitHub withholds secrets) but same-repo PRs
   run with secrets — acceptable for now (push access implies trust + label gate),
   but the npx switch removes the concern entirely.

### Prompt-injection posture (and the structural fix)

Untrusted input reaches the reviewer from three places; defenses by layer:

- **Diff content, PR title/body, filenames, commit messages** — the biggest and
  most obvious surface. Defended in-prompt: `shared.md` labels all reviewed content
  untrusted DATA (never instructions), neutralizes "ignore your instructions"-style
  injection, and rules that claims of intent ("this is safe/a fixture") carry no
  weight; the engine also sanitizes PR title/body + file paths (`sanitizeUntrusted`)
  and fences inlined diffs with BEGIN/END(untrusted) markers. This is mitigation,
  not a hard guarantee — an LLM can still be swayed — so it's defense-in-depth, not
  the last line.
- **Prior comments / dismissal state** — NOT fed back to the review agents (runs are
  stateless), so there is no injection path there. The embedded comment state is
  only ever read from the bot's own comment (GitHub write perms are the boundary).
- **The reviewer's OWN config, prompts, and code** — the sharpest vector, and the
  one not fully closed. The `pull_request` auto-workflow checks out the PR *merge
  ref*, so a same-repo PR can rewrite `.expo-code-review/` (agent prompts,
  `config.jsonc`, `tokenEnv`) **or the CLI source itself** and it runs with secrets.
  In-PR mitigations shipped: the `auth.ts` denylist refuses to forward well-known
  non-provider secrets even if config names them, and the security agent is told to
  treat PR-supplied config as attacker-controlled. **Structural fix (post-merge
  follow-up):** have the auto-workflow build + load config from the **trusted base
  ref** (the diff still comes from `gh pr diff`), exactly like the `/review` command
  workflow already does — or switch to the published package via `npx` (item 9).
  This can't land in *this* PR because the reviewer package isn't on `main` yet, so
  the base ref has nothing to build; it becomes available the moment this merges.

## 4. Caching (LLM cost / quota / latency)

Investigated 2026-07-21. Baseline finding: **OpenCode already applies Anthropic
prompt caching automatically** — the installed binary (1.18.1) adds
`cacheControl: {type: "ephemeral"}` (5-min TTL, hardcoded) to the first 2 system
messages and the last 2 non-system messages on every anthropic/bedrock/openrouter
request. So the expensive part — the per-session tool loop resending the whole
conversation each turn — is already incrementally cached; we should not add
`cache_control` markers ourselves. Under Claude Max OAuth, caching buys **quota
headroom and latency**, not dollars (`cost` is ~0 there anyway).

**Quality impact:** prompt caching replays byte-identical prefix tokens — the
model's output is unchanged, so items 1–3 below are quality-neutral by
construction (item 2 is arguably a small recall *gain*). Item 4 is the only one
that trades quality for cost — treat it as a product decision, not just an
engineering task.

What's left is at our layer, in suggested order:

1. **Log cache metrics (measure first).** OpenCode's assistant message info
   carries `tokens: {input, output, reasoning, cache: {read, write}}`; we already
   poll that object in `promptAgent` but only extract `cost`. Add `tokens` to
   `PromptResult` and the `.runs/reviews.jsonl` record. This also answers an open
   question we couldn't settle statically: whether our per-prompt `system` param
   lands inside OpenCode's "first 2 system messages" breakpoints (cross-session
   prefix reuse) or outside them.
   - *Caveat:* the `tokens` object likely reflects the most recent model request
     in the tool loop, not the cumulative session total — verify how OpenCode
     accumulates it before reading it as a per-task total. Fine either way for
     answering the breakpoint-placement question.
   - **Confirmed working (2026-07-22)** from local #4057 runs (OpenAI): cache
     reads ~106–110k tokens/run vs ~10–18k fresh input — provider prompt caching
     is clearly active. `cache.write: 0` there is an OpenAI reporting quirk (it
     reports cached-reads only). **Follow-up:** `.runs/reviews.jsonl` is ephemeral
     in CI, so the Anthropic (default) cache numbers aren't visible after a run —
     surface the token/cache totals into the CI job log or the run summary so CI
     caching can be confirmed the same way (Anthropic reports write + read).
     **✅ Shipped (2026-07-23, #6):** `formatUsageSummary` prints a one-line totals
     summary (input/output/reasoning + cache read/write + cost) via progress, so it
     lands in the CI job log and the local terminal.
2. ✅ **Retry in the same session, not a fresh one.** *(Already implemented.)*
   `promptAndParse` sends the `CORRECTIVE` nudge as a follow-up in the first
   attempt's session (the model still holds the file context — a cache read and a
   cheap re-emit), and only falls back to a fresh session as a last resort. The
   documented implementation trap is handled: it snapshots the message count
   (`baseline = (await fetchMessages(...)).length`) and waits for a *new* assistant
   message via `pollForCompletion(..., { fromIndex: baseline })`, so the
   already-completed first message isn't returned as stale text. Timeouts still stay
   fresh/abandon. *(Historical note: this section predates that implementation; kept
   for the rationale.)*
3. **Interleave tasks chunk-major, not agent-major (contingent on #1).** A cache
   entry is readable only after the first response starts streaming, so N
   parallel same-prefix requests all pay full write price. Tasks are currently
   built agent-major, so the first concurrency-4 wave is often 4 identical-prefix
   requests for one agent. Chunk-major order (agent 1 chunk 0, agent 2 chunk 0,
   …) writes each agent's prefix once and lets its later chunks read it.
   - *May be worth ~nothing:* most PRs fit in one chunk (`maxChangedLines:
     1000`), so there's one task per agent and ordering changes nothing; and the
     benefit assumes the agent-specific system prompt is inside OpenCode's
     first-2-system-messages breakpoints — if it lands third, the only reusable
     prefix is the base prompt + tools, identical across all agents regardless of
     order. Do this only if #1's measurements show agent-prefix reuse is real.
4. **Result-level caching across runs (biggest saver; the one with a real
   quality cost).** The 5-min server-side TTL means Anthropic's cache is cold by
   the next push to a PR, but most chunks are usually unchanged. Cache reviewer
   output keyed by `(agent id, model, prompt-version hash, chunk content hash)` —
   hash the patch *contents* + file list, not paths (patch paths embed the
   timestamped `runId`). On re-review, unchanged chunks reuse prior findings.
   Persist under `.runs/` locally; in CI needs `actions/cache` or an artifact
   keyed by PR number. Two design problems to settle **before** building:
   - *Chunk boundaries are unstable.* Chunking is greedy by changed lines over
     the whole file list, so one modified file in a new push can reshuffle every
     downstream chunk → different hashes → cache miss on everything. Needs either
     per-file caching (murky finding attribution — findings are per-chunk) or
     deterministic chunk assignment that's stable under small edits.
   - *Findings depend on more than the chunk — this is the recall trade.*
     Reviewers read the surrounding repo, and sibling changes can invalidate an
     "unchanged" chunk's conclusions (push 2 changes a signature in chunk B;
     chunk A's byte-identical caller reuses its cached "no findings"; the pass
     that would have caught the broken call never runs). Mitigations: always
     rerun the cross-cutting pass (the backstop — but it only exists on
     multi-chunk diffs and is currently the least reliable pass; see
     reliability); consider reusing only when the *rest* of the PR is also
     unchanged (rebase / comment-only push — safer, reuses less). Including base
     SHA in the key kills nearly all reuse; excluding it accepts staleness.
     Since the tool's value proposition is recall, decide how much staleness a
     re-review may tolerate before implementing.

Not worth pursuing: 1-hour TTL (hardcoded in OpenCode's transform, and cross-run
prompt caching is low-value since diff content dominates); padding prompts for
cacheability (tool schemas + base prompt + system already clear Sonnet 4.5's
1024-token minimum); router-call caching (one small call per run).

## 5. Improving the review process to catch bugs like #1 / #2 in the future

The Claude bot caught two things we missed. Why, and what to change:

**#1 — critical CI supply-chain (issue_comment + secrets RCE).** We missed it
partly because our only completed run predated that workflow (later runs stalled),
and partly because our `security` agent is primed for code-level vulns, not
GitHub-Actions threat modeling. Improvements:
- Add an explicit **CI/workflow-security** checklist to `security.md` (or a
  dedicated agent): trigger fork-restriction semantics (`pull_request` vs
  `issue_comment` vs `workflow_run`), `gh pr checkout` + secrets, `permissions:`
  scope, unpinned actions, install-time script execution, `pull_request_target`.
- Treat any change under `.github/workflows/**` as **always-review** (bypass
  chunking/routing so a workflow file is never the file that got skipped) and
  raise its severity floor.
- Never trust PR-description claims of mitigation (already policy) — verify which
  workflow a "mitigated for forks" note actually applies to.

**#2 — binary/NUL blind spot.** This was a *structural* miss: git marked the file
binary, our parser handed agents an empty patch, so the reviewer literally could
not see the file with the bug. The bot found it by doing its own working-tree
archaeology (`git show`/`od`), not by trusting the unified diff. Improvements:
- **Fixed** the immediate bug (parser flags binary; noise filters it).
- **Surface skipped/unreviewable files** in the review output ("N files not
  reviewed: binary/generated/too-large") so a coverage gap is visible, never
  silent. A finding we can't make is still information.
- Give agents (or a pre-pass) the ability to read the **working tree**, not only
  the unified diff, for files git can't diff cleanly — the bot's edge was exactly
  this.
- ✅ **Unit test suite (shipped).** `bun test` (`yarn test:unit`) — 36 tests / 8
  files over the deterministic core: diff parsing incl. binary detection, noise
  filtering incl. header-only markers + glob (`?` escaping, no-NUL), JSONC config
  parsing, JSON extraction, fingerprinting, prompt sanitization, render +
  fingerprint round-trip + coverage-note gating, quote-grounding, and
  chunking/policy/concurrency (incl. a guard for the index-vs-element FP). Each
  test guards a real regression from this session. Excluded from tsc (bun runs
  them). **Follow-up:** wire into CI — a small dedicated workflow on
  `packages/expo-code-review-cli/**` (needs bun), or the package's own CI on
  extraction; the monorepo's jest-based `lerna run test` doesn't pick it up (script
  is `test:unit`, and files are `*.test.ts` not the repo's `-test.ts`).

**Cross-cutting: self-review coverage.** The reviewer should be reliably run
against its own PRs at a size it can handle (the 49-file mega-PR defeated it —
see reliability items). A completed, non-degraded self-review would likely have
surfaced at least #2 once the parser/working-tree gaps above are closed.

## Audit follow-ups (2026-07-22) — remaining items

Three parallel audits (reliability / UX / speed) ran on 2026-07-22. The
failure-path cluster (never-approve-on-failure, coordinator fallback, always-post,
cross-cutting collapse, retry-explosion removal, LPT scheduling, timeout
alignment, concurrency + maxChangedLines bumps) shipped — see "Recently shipped"
and §3. What remains, by tier:

### Correctness bugs — ✅ shipped (2026-07-22)
- ✅ **GitHub comment lookup** now paginates all comments (manual paging; the
  issue-comments endpoint ignores `sort`/`direction` and returns oldest-first) and
  keeps the **newest** marked comment. Fixes duplicate reviewer comments and missed
  `/skip-review` on PRs with >100 comments. `reporters/github.ts`
- ✅ **Temp-dir leak** in `withBodyFile` fixed — try/finally `rm` of the `mkdtemp`
  dir, matching `auth.ts`. `reporters/github.ts`
- ✅ **Cost/token metrics** now capture the in-progress assistant's `cost`/`tokens`
  on timeout (threaded through `DeadlineReached` → the finalize result or
  `AgentTimeoutError`), so abandoned/finalized tasks contribute their spend.
  `opencode.ts`, `review.ts`

### Speed — ✅ shipped (2026-07-22)
- ✅ **CI fixed cost**: `fetch-depth: 1` + `cache: yarn` in both workflows.
- ✅ **`POLL_INTERVAL_MS`** 2s→1s.
- **Faster coordinator model** — *(left to config, not hardcoded)*: set
  `model:` in `coordinator.md` frontmatter (it uses no repo tools). Not forced so
  repos keep one model unless they opt in. *(Open: OpenCode event-stream instead
  of polling — larger change, deferred.)*

### UX — ✅ mostly shipped (2026-07-22)
- ✅ **Report → stdout, progress → stderr** (`ecr review > out.txt` now works).
- ✅ **Terminal: per-severity headers + counts + a one-line tally.**
- ✅ **Progress heartbeat** during silent model "thinking" (poll loop emits
  "still working… Ns elapsed" after 45s idle).
- ✅ **`doctor` checks `gh` + `gh auth status`**; **`ci --help`** added.
- ✅ **Clickable `file:line`** — shipped. Every finding location renders as a
  markdown link: in-diff (file+line in a hunk) → the PR "Files changed" diff anchor
  (`#diff-<sha256(path)>R<line>`); out-of-diff (unchanged code the PR references) →
  the source blob on the PR base commit (`/blob/<baseSha>/<path>#L<line>`, a stable
  permalink). The reporter fetches the diff-line index + base SHA (both fail soft to
  plain text). *Remaining (minor): the out-of-diff base-blob link can 404 in two edge
  cases — a finding citing a line beyond a PR-added file's length, or a
  wrong/hallucinated path. To guarantee zero 404s, link out-of-diff only after
  confirming the file exists on the base (one extra lookup per out-of-diff file),
  else plain text. Low priority — verified findings rarely cite bogus paths, and a
  404 is more visible than the dead diff anchor this replaced.*
- ✅ **Auth-shaped (401/403) agent errors → one actionable message** *(shipped
  2026-07-23, #5)* via `isAuthError` — collapses to a single coverage note.
- **Minor**: README uses `ecr` though unpublished (note once that real invocation
  is `yarn workspace expo-code-review dev …`); `init` next-steps vs scaffolded
  `auth.mode`; ~~warn when `--staged` is combined with `--base`/`--head`~~ ✅ shipped
  (#2 — now rejected with a clear error).

## Extraction — done ✅ (remaining cleanup)

The package has been extracted from `expo/eas-cli` into this standalone repo and
published as `@expo/code-review-cli`. eas-cli now carries only its
`.expo-code-review/` config and the workflows, which run the reviewer via `npx`
(the in-repo `yarn build`-from-source workflows are gone). The monorepo's oxlint/
oxfmt/tsconfig exclusions for the package were removed on the way out.

Still open:

- **Give this repo its own lint + format setup** (oxlint/oxfmt or ESLint +
  Prettier) and wire it into CI (`test.yml` currently runs typecheck + build +
  `bun test`). The standalone ESM/NodeNext choice is now just this repo's standard,
  not a divergence — no CommonJS refactor needed.

## Model selection & fallback

Current: `config.jsonc` `model` is the default; per-agent and `coordinator.md`
frontmatter `model:` override it; `REVIEWER_MODEL` env is a global override.
Precedence: env > frontmatter > config default. In use: Sonnet 5 for the
specialists + cross-file pass, Haiku for the coordinator.

**Decision (2026-07-22): do NOT auto-map to a cross-provider "equivalent"** (e.g.
silently swapping `anthropic/claude-sonnet-5` for an OpenAI model when only OpenAI
is authed). Reasons: "equivalent" is subjective and drifts with every lineup
change (an ongoing, frequently-wrong mapping table); and silently running a review
on a different model than configured hides *why* findings changed — for a review
tool, a clear failure beats an invisible substitution. Explicit overrides
(`REVIEWER_MODEL`, frontmatter `model:`) are the portability primitive.

Wanted instead:
- ✅ **Fail-fast provider-auth check** *(shipped 2026-07-23, #4.)* `checkProviderAuth`
  (shared by `doctor` + `prepareAuth`) says up front when the configured provider has
  no credential ("configured `anthropic/…` but token env X isn't set — set
  `REVIEWER_MODEL` or authenticate") instead of surfacing as N failed passes mid-run.
  Removes most of the perceived need for a fallback.
- **Optional, opt-in `fallbackModel`** for availability only: fires ONLY on the
  primary being unavailable / rate-limited / errored, and is **surfaced in the
  review output** ("primary X unavailable; this pass ran on fallback Y") — never
  silent. Would need to be tier-aware given the mixed-model setup (a single global
  fallback would flatten the specialist-vs-coordinator model distinction).
- **First-class multi-provider support (Anthropic / OpenAI / others).** Today only
  Anthropic has clean config-level auth (`api-key` / `oauth`); using GPT or another
  provider works only through the `REVIEWER_MODEL` env override plus a manual
  `opencode auth login`. Make provider + auth selection first-class in `config.jsonc`
  (and per-agent frontmatter) so a repo can, from config alone, run entirely on
  OpenAI, or mix — e.g. GPT for one agent and Claude for another, or a GPT
  coordinator over Claude specialists. Both Anthropic and OpenAI should be equally
  supported, with room for more (Google, OpenRouter, local). Pairs with the
  fail-fast provider-auth check above.

## Full-repository review (audit mode)

Today the reviewer only reviews a *diff* (a PR or a working-tree range). Add a mode
that reviews an **entire repository**, not just changed lines — for onboarding an
existing codebase, a one-time security/quality audit, or establishing a baseline
before turning on PR review. Design sketch:

- New entry point (e.g. `ecr review --all` / `ecr audit`): enumerate the repo's
  source files (respecting the noise filter + an explicit scope of paths/globs and a
  size ceiling) instead of taking a diff.
- Reuse the existing chunk → agents → cross-cutting → coordinate → verify pipeline,
  but chunk the whole tree by directory/package proximity rather than by changed
  lines. This is large, so it leans hard on the reliability machinery (subdivide,
  budgets) and almost certainly wants incremental/resumable state (§ merge-boundary
  #1) so an audit can run in bounded passes and resume.
- Output is a standalone report grouped by severity/area (written file + terminal
  summary, `--json` for tooling) — not a PR comment.
- Cost/time will be large on a real repo: make scope explicit, cap it, and report
  what was and wasn't covered (never silently partial).

## Review trustworthiness — false positives + finding stability

Two related problems observed on #4022: a **hallucinated critical** (claimed
`mapWithConcurrency` did `const item = next++` and was "uncompilable"; the code is
`items[next++]!` and builds fine), and a **hamster wheel** where each run surfaces
"new" issues that existed before. Both erode trust; both need addressing before this
is dependable.

### A. Validate findings before surfacing (especially criticals)

Root cause: the reviewer runs one pass per agent with no verification, so an LLM's
plausible-but-wrong claim ships as-is. Fixes, cheapest/highest-leverage first:

1. ✅ **Quote-grounding (deterministic) — shipped, then softened.** Findings carry an
   `evidence` field (the flagged code, verbatim); `verifyFindings` grades it against
   the real file. Originally, evidence absent from the file was a **hard drop**.
   Measured on ~13 real PRs that proved too aggressive: it dropped 3 findings vs. 1
   surfaced, and ≥1 dropped finding was a **confirmed real bug** (#4057's "--account
   silently ignored"). Root cause: exact-substring is a good POSITIVE signal but a
   poor NEGATIVE one — it misfires on structural/"missing" bugs (no single line *is*
   the bug), cross-line quotes, ellipsis, copied comment/diff markers, and slightly
   wrong locations. **Fix (shipped 2026-07-23):**
   - **Fuzzy match** (`matchEvidence`/`evidenceFragments`): exact substring OR any
     substantive line/fragment present verbatim, after stripping comment/diff markers
     and splitting on newlines + ellipsis. Rescues the mechanical misquotes.
   - **Escalate, don't drop:** absent evidence (any severity) now routes to the LLM
     verifier (which re-reads the real file + nearby files) instead of being dropped;
     a finding is dropped ONLY on refutation. `present`/`unknown` non-criticals keep
     the cheap no-LLM fast path.
   - **Verifier judges substance, not wording:** the verifier prompt now treats the
     quote as an imperfect hint and rejects only if the underlying problem isn't real;
     the reviewer prompt asks for one contiguous verbatim line (no ellipsis/paraphrase).
2. ✅ **Adversarial verify pass — shipped (now all-severity on demand).** A restricted
   `verifier` agent (read+grep) re-reads the cited file and must confirm the finding is
   genuine (biased to reject). Runs for every critical, and for any finding whose
   evidence didn't ground (see #1). Parallel, 3-min cap, fails open (keeps the finding
   if verification itself errors). Decision is re-derived after drops (no criticals
   left → soften `request_changes`).
3. ✅ **`--pr` verification fidelity — read the PR-HEAD tree, not the checkout.**
   *(Shipped 2026-07-23; found re-testing #4057.)* On a `--pr` run the diff is
   authoritative from `gh`, but the agents' and the verifier's surrounding-source
   reads came from whatever was checked out. Re-reviewing #4057 (the PR that *adds*
   `--account`) from a `main` checkout, the verifier read `main`'s `init.ts` — no
   `--account` — and **false-refuted** the real "--account ignored when already
   linked" finding — the mirror image of the quote-grounding over-drop (#1). **Fix:**
   a source can now `prepareReadRootAsync()`; `GitHubPRSource` checks the PR head
   (`refs/pull/<n>/head`, fetched from the repo URL so forks work) out into a
   throwaway git worktree, and `runReview` chdirs into it for the agents + verifier
   (config is already in memory; run-log/patch paths are absolute; fails soft to the
   current directory). This also fixes CI's `/review` **command** workflow, which
   checks out the base ref — it was reviewing base, not the PR. (The config-not-on-an
   -old-PR-branch problem is sidestepped: config loads from the checkout, source
   reads from the head worktree — two trees, resolved independently.)
4. **Oracle checks.** A finding that asserts "won't compile / type error" can be
   validated against `tsc`; "crashes"/"breaks tests" against the test suite. At
   minimum, never surface a compile-error claim when the package compiles.
5. **Severity-gated effort:** criticals get the most scrutiny — they carry the most
   weight and are the most damaging when wrong.

### B. Finding stability (stop the hamster wheel)

Why "new" issues appear every run, roughly in order of impact:

1. **Partial coverage from timeouts** — the dominant cause. When passes time out,
   each run reviews a *different subset*, so pre-existing issues surface only when a
   completing pass happens to reach that file. Every recent comment carries a
   "coverage note." **Full coverage per run** (the chunk-1000 + cap work, and the
   size guard for the extreme tail) is the #1 fix — with complete coverage the
   finding set converges.
2. **Findings not fixed when first raised** re-surface every subsequent run. Fix (or
   explicitly `expo-code-review-ignore`) them when raised.
3. **LLM nondeterminism** — some run-to-run variance is inherent (temp already 0.1);
   the high-signal findings recur, noise doesn't.
4. **Moving-target self-PR** — #4022 is the reviewer reviewing its own constantly
   growing PR, so some "new" issues are genuinely new code. A normal, stable PR with
   full coverage would not churn like this.
5. Full-diff-every-run re-evaluates the whole backlog each push; fingerprint dedup +
   the single updated comment already mitigate, but a future option is reviewing the
   incremental delta and/or persisting resolved-finding state.

Bottom line: most of the churn is an artifact of (1) partial coverage + (4) a
self-referential moving target, plus FPs from missing validation (§A). Closing
coverage and adding quote-grounded verification should make runs boringly stable.

## Telling the reviewer "I don't care about this" (suppression)

Design from a focused investigation. Principle for everything below: **suppression is
a display filter, never a review skip; dismissed items collapse into an auditable,
reversible section rather than vanishing; and a `critical`/`secrets` finding is never
silently erased** (it escalates to a "needs human sign-off" note).

**Two latent bugs found while designing this:**
- **Fingerprint is unstable.** `fingerprintFinding` (`schema.ts`) keys on the
  LLM-written `title`, which varies run-to-run at temp 0.1 — so any *persistent*
  dismissal keyed on it would silently lapse and the finding re-surfaces. Must fix
  before building dismissal.
- **The inline `expo-code-review-ignore` directive is prompt-only** — grep finds zero
  code references; suppression today depends entirely on the model choosing to obey.
  Needs a deterministic backstop.
- Also: `parseEmbeddedFingerprints` (`render.ts`) has no callers — the embedded
  `fingerprints=[…]` comment block is a built-but-unused substrate, ideal for storing
  dismissals.

**Build order (✅ = shipped):**
1. ✅ **Fingerprint v2.** Re-keyed on the verbatim `evidence` snippet
   (`sha1("v2"|file|category|normalizeCode(evidence))`), falling back to title only
   when evidence is too short. Each finding now shows a short `` `id:…` `` in the
   comment. Dismissals lapse when the code changes — correct.
2. ✅ **Per-PR `/dismiss <id>` (+ `/undismiss`).** Maintainer-gated `issue_comment`
   workflow (`expo-code-review-dismiss.yml`, base-ref-only, no model secret) → `ecr
   dismiss/undismiss`. Dismissals stored as embedded state **in the bot's own comment**
   (read only from there); the reporter re-renders dismissed findings into a collapsed
   `<details>` section and carries them forward across re-reviews. The comment embeds
   the full review state (base64) so `/dismiss` re-renders without re-running.
3. **Repo config `policy.suppress`** — *(skipped for now, deliberately.)* Persistent
   cross-PR class-level opt-outs (byCategory / byPathGlob / byTitlePattern /
   severityFloor). Revisit if per-repo class suppression is wanted.
4. ✅ **Inline-directive backstop.** `expo-code-review-ignore` on/above a line now
   deterministically drops that finding (was prompt-only), with a **critical/secrets
   carve-out** (never suppressed this way).

**Precedence** (only `/skip-review` truly skips): `/skip-review` > inline directive >
(config `policy.suppress`, when built) > per-PR `/dismiss`. All but `/skip-review` are
display filters; agents always analyze everything.

**Not fed to agents (by design):** prior comments/findings are NOT threaded back into
the review agents — each run is stateless (diff + repo + PR title/body only).
Suppression/dedup is a post-agent display concern (fingerprints), so agents can't be
anchored by, or biased into hiding via, a previous run or a dismissal. Cross-run
*context* feedback would be a deliberate future feature with real anchoring/echo/
security tradeoffs.

**Fits §1 (inline comments):** dismissal is the first real consumer of the fingerprint
substrate; after §1, a 👎/reply on an inline thread maps to the same `dismissed[]`
store (thread↔fp gives the identity a single comment can't), so this design is forward
work, not throwaway.

## Per-PR review guidelines (trusted-author-gated) — future

Let a PR give the reviewer extra per-PR direction — e.g. a `## Review guidelines`
section in the description with bullets like "ignore the `.md` files" or "focus on
the API changes". Genuinely useful, but the PR description is the **untrusted**
channel the injection defenses (`shared.md`) exist to neutralize, so this needs to
be built as a *trusted, bounded* mechanism, never a free-text instruction pipe.

Design constraints:

- **Trusted-author gate.** Only honor the block when the PR author is
  `OWNER|MEMBER|COLLABORATOR` — read `github.event.pull_request.author_association`
  (zero API calls; already the pattern in `expo-code-review-dismiss.yml`) or the
  collaborator-permission REST API for an authoritative check. `CONTRIBUTOR`/`NONE`
  are **not** trusted (CONTRIBUTOR just means a prior merged PR, not push access).
  For untrusted authors, ignore the block and note that it was skipped.
- **Allowlisted, structured directives — not prose spliced into the agent prompt.**
  Parse bullets into known actions applied *deterministically in code*: "ignore
  `**/*.md`" → an `additionalIgnores` entry in the noise filter (not "please ignore"
  sent to the LLM). A focus hint may be passed as clearly-fenced *context*, but the
  parser decides what is a directive, so arbitrary text can't become an instruction.
- **Same carve-outs as suppression.** Guidelines may narrow scope or add focus; they
  may **never** suppress `critical`/`secrets` findings or force a decision.
- **Repo-wide guidance belongs in trusted config**, not the description: a
  `guidelines` field in `config.jsonc` (or a `guidelines.md`) is maintainer-owned and
  side-steps the trust problem entirely. Do this first; the PR-description path is
  only for *per-PR* direction and layers the author gate on top.
- **Pairs with the base-ref checkout (§ merge-boundary #4):** once config loads from
  the trusted base ref, repo-level guidelines are unambiguously trusted, and the
  author gate is the only extra check the per-PR path needs.

## Noise filter: derive from the repo's lint/format ignores (opt-in) — future

Today noise filtering is content-based (generation markers) + a few path heuristics
(lockfiles, `.min.js`/`.map`, snapshots, binary) + explicit `noise.additionalIgnores`.
A repo's **lint/format ignore files** (`.eslintignore`, oxlint `ignorePatterns`,
`.prettierignore`) already encode "not hand-maintained / not worth linting", which
overlaps with review-noise — worth folding in. Constraints, because this is more
aggressive than suppression (a filtered file is dropped before ANY agent sees it,
with no critical/secrets carve-out):

- **Opt-in**, not default. Lint-scope ≠ review-scope: a repo may not *lint* vendored/
  legacy code that should still be *security-reviewed*. Blanket import could silently
  drop security coverage.
- **Lint/format ignores only — never `.gitignore`** (that's about what's *tracked*,
  not noise; diff files are tracked, and its negation/nesting semantics are fiddly).
  `tsconfig` `exclude` is a weak signal at best.
- **Read from the trusted base ref, not the PR.** In the auto-workflow, ignore files
  come from the PR merge ref — a PR could add its own file to `.eslintignore` to dodge
  review. Same trust boundary as § merge-boundary #4.
- **Stay transparent** — keep recording filtered files (already done), ideally noting
  which ignore file matched.
