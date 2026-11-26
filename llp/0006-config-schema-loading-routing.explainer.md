# LLP 0006: Config Schema, Loading, and Monorepo Routing

**Type:** Explainer
**Status:** Active
**Systems:** Config, Security
**Author:** Philippe Loulidi / Claude
**Date:** 2026-07-30
**Related:** [LLP 0001 Trust Model](0001-trust-model.principles.md), [LLP 0004 Diff, Noise, and Prompts](0004-diff-noise-and-prompts.explainer.md), [LLP 0007 CLI Commands and CI](0007-cli-commands-and-ci.explainer.md), [LLP 0009 Adoption Templates and CI Workflows](0009-adoption-templates-and-ci-workflows.guide.md)

`src/config/` owns the shape of `.expo-code-review/config.jsonc`, how a repo's config
is discovered and fully resolved into a `LoadedConfig`, and how a monorepo splits one PR
into per-scope reviews via `routing.jsonc`. This doc records the WHY behind the choices
that are easy to "simplify" back into bugs: which keys a scope may set, why the auth union
is ordered the way it is, why one env override uses `.trim() || undefined` instead of
`??`, and why several checks are deliberately duplicated. The loader is intentionally
agnostic to *where* it is pointed; the trust decision (base commit vs PR head) lives in the
caller, [LLP 0007](0007-cli-commands-and-ci.explainer.md) and [LLP 0001](0001-trust-model.principles.md).

## Root vs Scope Config

A scope config is the root schema minus the centrally locked keys. `ScopeReviewConfigSchema`
takes `ReviewConfigSchema`, omits `auth`, `breakGlass`, and `commentTag`, and re-adds each as
`z.never().optional()` so declaring any of them is a hard parse error, not a later runtime
check [observed: `schema.ts:232-247`]. The point of failing at the Zod level is that an IDE or
`doctor` catches it before CI does [observed: `schema.ts:224-225` comment]. The remaining
overridable keys (`model`, `policy`, `chunk`, `noise`, plus the prompt files beside them) are
an explicit allowlist modeled on Turborepo-style config inheritance, cited in code as
"graft 6" [observed: `schema.ts:222`].

Locking `commentTag` is a correctness invariant, not tidiness. Per-scope comment markers must
be *derived* (`<rootTag>:<scope>`), never independently set, so that `ecr ci`'s
post/clear/reconcile paths and a standalone `ecr review --scope --post` always target the same
marker; an honored per-scope tag would let the two halves strand each other's comments
[observed: `schema.ts:241-246`]. The default scope (`scope.config === "."`) is the deliberate
exception: it keeps the ROOT marker rather than deriving `<rootTag>:default`, so a repo that
adds routing on top of an existing single-scope setup upserts its one PR comment (and its
dismissal state) in place instead of duplicating it (risk 8) [observed: `load.ts:290-292`].

Enforcement of a mandatory reviewer is a third layer. `manifest.defaults.enforceAgents` injects
each named agent from the ROOT roster into every scope with `alwaysRun` forced true, and the
injection loop overwrites any same-id agent the scope defines so the enforced version always
wins (risk 11) [observed: `load.ts:313-330`]. A team-owned scope cannot shadow or weaken an
enforced (e.g. security) agent on its own subtree. The loop order is load-bearing: it copies the
scope's own agents first, then overwrites/pushes the enforced ones; a naive `Object.assign` the
other way would let the weaker scope agent win.

## Auth Config Shapes

`auth` accepts two shapes and normalizes both to `AuthConfigEntry[]`: a legacy single credential
`{ mode, provider, tokenEnv }`, and a per-provider map `{ providers: { <id>: { mode, tokenEnv,
upstream? } } }` [observed: `schema.ts:78-112`, normalized in `load.ts:181-209`]. The map form
is not a convenience alias; it exists to support a MIXED credential setup, e.g. `openai` on a
ChatGPT/Codex subscription for default models plus an `openai-api` alias (`upstream: "openai"`)
on a metered API key for pro-tier models the subscription does not offer, letting one upstream be
reached with two credentials at once [observed: `schema.ts:66-72, 97-101, 284-289`; commit `43b31a4`].

The union tries the map form FIRST, and that order is load-bearing. Every key of the legacy
object carries a default, so a non-strict legacy parse of a `{ providers }` object would succeed
by stripping the unknown key, silently gutting a multi-provider config down to the single default
credential [observed: `schema.ts:74-76` comment]. Reordering the union to "simplify" it
reintroduces exactly this silent data loss.

For provider `anthropic`, the `mode` field (api-key vs oauth) is IRRELEVANT to how the credential
is used: an `anthropic/…` model is always served by the Claude Code CLI engine (the engine is
inferred from the model string, not the mode), which reads `tokenEnv` or falls back to the
machine's `claude` login regardless of mode [observed: `schema.ts:89-94, 270-275`]. See
[LLP 0003](0003-model-runtimes-and-credentials.explainer.md) for the engine split.

One schema comment is historical and must be read as such. `schema.ts:85-88` and `schema.ts:277-282`
describe the `openai` oauth `tokenEnv` as holding a REFRESH token, on the reasoning that access
tokens live ~1h (shorter than a worst-case run) so the refresh token is the durable secret from
which OpenCode's codex plugin mints access tokens. That was the original design intent. Commit
`188f8521` later found in production that refresh tokens are SINGLE-USE (the shared copy was spent
by its first CI use) and added ACCESS-token support as the actual shared/CI-credential strategy.
The comment was not updated; treat it as superseded rationale, not current guidance for CI. It is
documented here rather than deleted so a future reader does not "restore" the refresh-token flow
[observed: `schema.ts:277-282` comment vs commit `188f8521`].

The credential names, once configured, are locked at runtime by `tokenEnvMismatch`: it compares the
configured `tokenEnv` set against an expected comma-separated set as an order-insensitive EXACT
match (set semantics, not substring/prefix), so a config can neither add, drop, nor repoint any
well-known credential env to a different provider than expected [observed: `load.ts:211-233`;
commit `43b31a4` follow-up]. The actual secret values never enter this subsystem: `src/core/auth.ts`
owns the wiring and the `FORBIDDEN_TOKEN_ENVS` list, and schema/load only ever touch the env-var
NAME [observed: `AGENTS.md` security invariants; `src/core/auth.ts:28,45,206`].

## Model Resolution

The `REVIEWER_MODEL` env override is applied on top of frontmatter/default model resolution using
`process.env.REVIEWER_MODEL?.trim() || undefined`, deliberately NOT `??`
[observed: `load.ts:103-114`]. GitHub Actions passes an unset repo variable
`${{ vars.REVIEWER_MODEL }}` as an EMPTY STRING, not undefined/null, which `??` does not catch.
With `??`, an empty string replaced every configured model id, so every agent and the coordinator
silently ran on whatever OpenCode defaulted to (its free gateway model) for weeks with nothing
reporting it [observed: `load.ts:103-109` comment; commit `43b31a4`: "reviews silently ran on
opencode's free gateway model for weeks"]. The `.trim()` also absorbs a stray newline, the same
class of accident. This is not a style choice; five dedicated regression tests lock the empty,
whitespace-only, real-value, and trimming cases [observed: `scope-config.test.ts:282-338`]. Any
refactor of `resolveModel` that reintroduces `??` reintroduces the production bug.

## Routing Manifest

`routing.jsonc` is the monorepo manifest: an ordered list of scopes, each mapping a set of globs to
a directory that holds its own `.expo-code-review/`. Files are assigned LAST-MATCH-WINS, mirroring
CODEOWNERS discipline so a specific override placed later in the array beats an earlier catch-all
[observed: `schema.ts:187` comment; `routing.ts:75-80`]. Each changed file lands in at most one
scope's file list (or `unmatched`); files matching more than one scope are recorded once in
`overlaps` for diagnostics only, never double-counted [observed: `routing.ts:87-103`]. Only scopes
with ≥1 matched file are "active", and active order follows manifest declaration order, not match
order [observed: `routing.ts:105-111`].

`scope.config` is a PR-controllable input because `routing.jsonc` is read from the PR-head checkout
in the non-trusted path, so its schema `refine()` rejects absolute paths and `..` traversal
segments; without it a malicious PR could point a scope's config dir outside the repo
[observed: `schema.ts:137-148`]. `loadScopeConfig` re-checks the resolved path stays under the repo
root at runtime, described in code as "defense in depth" [observed: `load.ts:294-302`]. Both checks
are intentionally present; removing either as "redundant" reopens the escape.

Two Zod-level traps are worth calling out. First, uniqueness: every scope must have a unique `name`
and a unique `config` dir after `path.normalize`, enforced by a `superRefine` that raises a hard
parse error rather than silently deduping or applying last-wins [observed: `schema.ts:190-215`].
Second, zod v4's `.default().optional()` chain still fires the default on an absent key, so
`defaults.auth` unwraps the inner `.default()` before `.optional()`; the bare chain would fabricate
a phantom `{ mode:'api-key', provider:'openai' }` for every manifest that omits auth and silently
override the root config's real (e.g. oauth) auth [observed: `schema.ts:174-180`; regression test
`scope-config.test.ts:141-158` "no phantom stub"]. Near a `.default()` in this file, a bare
`.optional()` should be treated as suspicious, not idiomatic.

The manifest has three states, kept distinct on purpose. Absent file returns `null`, a
backward-compatible single-config state that is byte-identical to pre-routing behavior. A malformed
or present-but-empty manifest throws loudly; `RoutingManifestSchema` requires `scopes.min(1)`, so an
explicit empty manifest is always rejected. There is no silent fallback to single-scope behavior on
a bad manifest [observed: `routing.ts:26-38`, `schema.ts:188`].

The glob dialect is shared with `noise.additionalIgnores` via `matchesIgnore`
([LLP 0004](0004-diff-noise-and-prompts.explainer.md)), and `patternVariants()` works around a
limitation there: `matchesIgnore` translates `**` to `.*`, which needs at least one slash, so a
naive `**/*` catch-all would silently miss root-level files (`README.md`, `package.json`). Routing
tests every variant that keeps or removes each `**/` independently, giving each one its conventional
"zero or more directories" meaning: `**/ios/**/*.swift` matches `ios/A.swift` and
`packages/ios/src/A.swift` alike. Removing them only all at once or not at all, as it once did, missed
the mixed depths. A pattern with more than six `**/` falls back to that all-or-nothing pair, which
bounds the variants at 64 [observed: `routing.ts` `patternVariants`]. The
"proper" fix lives in `matchesIgnore` itself, whose blast radius covers noise filtering too, so the
workaround stays local. `matchesPathGlobs` is that wrapper, exported so agent `paths` (below) match
in exactly the routing dialect; a change to it changes scope assignment and agent selection together.

## Agent Frontmatter and `paths`

`parseFrontmatter` is a minimal YAML-ish reader, not a YAML library, for the same reason the JSONC
reader is: agent prompts are trusted config read from the base commit. The frontmatter must open on
the first byte of the file, and lines split on LF or CRLF. Every `key: value` line lands in `data`
as a scalar, exactly as before lists existed, so `description`, `alwaysRun`, `model`, and
`temperature` parse byte-identically. A `# comment` after a value is NOT stripped; it stays part of
the value. Keys whose value is a list ALSO land in `lists`: a one-line
flow list (`paths: ["a/**", 'b/**', c/**]`, trailing comma allowed) or a block list (`paths:`
followed by `- item` lines; blank and `#` lines inside are skipped, and the next key ends it)
[observed: `load.ts` `parseFrontmatter`, `parseFlowList`]. Only `paths` and `mention` read
`lists`.

`parseAgentPaths` validates `paths` at load time, because a mistyped glob would otherwise skip
the agent on every PR with nothing reporting it. An invalid value is a **setup warning, not a load
error**: the agent keeps no `paths`, so it reviews every change, and the warning names the agent
file and the fix [observed: `load.ts` `parseAgentPaths`]. A load error would be worse than the
typo. In CI, `ecr ci` reports a load error to stderr and posts nothing (it must never fail the
check), so one agent's typo would stop every review in the repo. And nothing catches the typo
first: CI reviews a PR under its base commit's config, so the PR adding the typo loads fine, and
`ecr verify-config` does not read agent files (it is the credential guard,
[LLP 0007](0007-cli-commands-and-ci.explainer.md)). The AGENTS.md "fail fast" rule is for setup
errors that would fail every pass anyway (a bad model id, a credential); an invalid `paths` can
degrade instead, to the behavior the agent had before it declared `paths`.

The value is invalid when it is not a list, is an empty list, has an empty entry, or has a glob
that can never match a repo-relative changed-file path: a leading `/` or `./`, a trailing `/` (the
CODEOWNERS directory form), and a leading `!` (negation is not supported). Typos the reader would
otherwise turn into a glob that matches nothing are invalid too: an entry with a `# comment`, text
after its closing quote (a missing comma between two quoted entries), a block item written `-x`
with no space, and a `{a,b}` brace set or an unmatched brace (an unquoted `{a,b}` splits at its
comma) [observed: `load.ts` `pathGlobIssue`]. The matcher itself never rejects a string, because
`matchesIgnore` escapes every regex metacharacter, so these are the only globs that can be
"invalid". Characters such as `[`, `]`, `?`, and braces without a comma stay literal and legal:
route file names such as `app/[id].tsx` contain them, and template directories such as
`{{cookiecutter.slug}}` contain braces.

The same warnings cover the rest of a prompt file's frontmatter, for `shared.md`, `coordinator.md`
and every agent [observed: `load.ts` `frontmatterWarnings`]: a frontmatter block below an HTML
comment, a byte-order mark or blank lines (the reader ignores all of its keys; repos scaffolded
before the templates moved their `@ref` comment have this), and a trailing `# comment` that breaks
`alwaysRun`, `model` or `temperature`. These only report: the file loads exactly as before, because
parsing through the hidden block would suddenly apply model pins the repo's credential may not
cover. Warnings land in `LoadedConfig.setupWarnings`, absent when there are none so a clean setup
keeps its review-cache key. `runReview` puts them first in `setupNotes` on every result, early
returns included, so the PR comment's **Review setup** note keeps naming the fix; `ecr doctor`
fails on them. A deprecated config key that still loads as before (`policy.includeSuggestions`,
mapped to `policy.minSeverity`) lands in `LoadedConfig.deprecations` instead: it rides in the same
setup notes, but `ecr doctor` only warns on it, because nothing about the review changes and
every repo scaffolded before the rename would otherwise fail doctor [observed: `load.ts`
`resolvePolicy`; `doctor.ts`].

An agent without `paths` gets no `paths` key at all, not `paths: undefined`, so its object shape
and its review-cache key are unchanged [observed: `load.ts` agent construction]. The
`defaults.enforceAgents` injection copies the root agent with its `paths`, so an enforced agent
still runs only in scopes with a matching file. How the engine applies the filter is in
[LLP 0002](0002-review-engine-pipeline.explainer.md#agent-paths-filter).

`mention` names the people an agent may ask for a human review: a list of GitHub logins or
`org/team` slugs, with an optional leading `@` that the loader drops. It is the only source of
whom a review notifies. The agent itself only writes the reason, so a PR cannot make the bot
mention anyone: CI loads agent files from the base commit, and the model never chooses a login.
`parseAgentMention` treats a value that is not a list, or an empty list, like an invalid `paths`:
a setup warning that names the file and the fix, and the agent mentions no one. An entry that does
not match `MENTION_TARGET_RE` is different: it is left out with a warning that names it, and the
agent still mentions the valid entries, because one typo should not silence the people listed
beside it. `MENTION_TARGET_RE` follows GitHub's rules: a login is at most 39 letters, digits and
single inner hyphens, with an optional Enterprise Managed User `_shortcode` suffix, and a team slug
is letters, digits and underscores joined by single hyphens. An agent without `mention` gets no
`mention` key, so its shape and review-cache key are unchanged [observed: `load.ts`
`parseAgentMention`; `schema.ts` `MENTION_TARGET_RE`].

## Agent Effort

An agent file may set `effort: low|medium|high|xhigh|max` in its frontmatter. The need came from an
eval replay on one monorepo: a correctness reviewer on an `anthropic/…` model ended a pass after a
median of 8 turns [observed], and a model-written miss analysis put 20 of 55 problems that human
reviewers raised in the class "needs a logic trace" (eval run `full-v2-tune`, 2026-11-25; the data
is private and not in this repo; no person checked the analysis). Depth is a per-agent need, and it costs time and money, so it is a
per-agent key and not a run-level flag.

- **The claude-code engine passes it as a flag.** `startClaudeCode` copies the declared levels into
  `ClaudeCodeHandle.efforts`, and `runClaudePrompt` passes `--effort <level>` for that agent's
  passes [observed] (`buildClaudeArgs` `effort`; tests in `src/__tests__/claude-code.test.ts`). The
  fixed roles (cross-cutting, verifier, adjudicator, stack verifier, coordinator) have no entry and
  get no flag. The flag exists in the pinned `@anthropic-ai/claude-code@2.1.280` [observed]
  (`claude --help`, 2026-11-25).
- **The levels are keyed by pass id, so fixed-role ids are excluded.** Passes are looked up by
  agent id, and a reviewer file can share a fixed role's id (`agents/verifier.md`). With an entry,
  its level would also reach the built-in pass of that id. `buildAgentEfforts` gives such a
  reviewer no entry, and the run note tells the author to rename the file. The id set is the
  session archive's `NON_REVIEWER_AGENTS`, so the two cannot drift. The levels live in a
  `Map`, so an id such as `constructor` cannot read an inherited `Object.prototype` value
  (both found in review of the first version, PR #118).
- **OpenCode passes it for OpenAI and Google models.** OpenCode hands unknown agent-config keys to
  the provider as model options. `buildOpencodeConfig` adds one per reviewer with `effort`, chosen
  by `opencodeEffortStyle` from the adapter ecr gives the model's provider: native `openai` and an
  alias with `upstream: "openai"` (built on `@ai-sdk/openai`) get `reasoningEffort`; native
  `google` and `google-vertex` get `thinkingConfig.thinkingLevel`. Any other alias, including
  `upstream: "google"` (built on `@ai-sdk/openai-compatible`), gets nothing: a Google key on that
  adapter reached a mock endpoint as a top-level `thinkingConfig` on `/chat/completions` (found in
  review of PR #119). Observed with the pinned OpenCode 1.19.5 against a local mock
  endpoint (2026-11-26) [observed]: with no key, an `openai/gpt-6.2-astra` request carried no
  `reasoning` field; `reasoningEffort: "xhigh"` and `"max"` arrived as `reasoning.effort`; a
  `google/gemini-4-neon` request carried `thinkingConfig: {includeThoughts: true, thinkingLevel:
  "high"}` with no key, and `thinkingLevel: "low"` replaced the `high`. Only reviewer entries get
  the key: the fixed roles are written after the reviewer loop, so a reviewer that shares a fixed
  role's id cannot give that pass its level. The pinned Google adapter takes `thinkingLevel`
  `minimal`, `low`, `medium` and `high`; with `xhigh` or `max` the pass failed inside OpenCode
  (an invalid-provider-options error) with no request sent, on `google/…` and `google-vertex/…`
  [observed]. OpenCode's model catalog lists more variants for some Gemini models; the limit comes
  from the bundled Google SDK's option schema, so re-check it when the OpenCode pins move. So
  `GOOGLE_THINKING_LEVELS` is `low`, `medium`, `high`: for the other two ecr sends no
  key, the model runs at OpenCode's default (`high`), and the run note names the agent, its level
  and the levels that work. Not observed: the ChatGPT/Codex sign-in path and a
  real provider's response to each level. ecr passes the level as written; a provider that does
  not take it fails that agent's passes with its own error.
- **No level on OpenCode's own agent ids.** OpenCode 1.19.5 defines `build`, `compaction`,
  `explore`, `general`, `plan`, `summary` and `title` (`app.agents()`, 2026-11-26) [observed]; a
  reviewer config with one of these ids replaces that agent, and `compaction`, `summary` and `title`
  also run for other sessions. A reviewer level there reached another reviewer's session
  compaction (found in review of PR #119), so `buildOpencodeConfig` gives these ids no level
  (`OPENCODE_BUILTIN_AGENTS`), and the run note tells the author to rename the file.
- **Any other OpenCode-routed agent ignores it, with a note.** `agentEffortNote` names agents whose
  OpenCode provider takes no level (Meta, OpenAI-compatible and others) once per run, the same way
  `claudeTemperatureNote` reports a temperature the CLI cannot take.
  `selectReviewers`, which `runReview` calls, builds it from the selected reviewer list, after the
  `paths` filter and the router, so an agent either of them left out is never named. A later step
  (a blocking pre-check, the budget) can still skip a named agent, so the note states a fact about
  the setup ("has no effect for X"), not about a pass that ran.
- **The model must support effort.** The CLI accepts every level for every model, but a model
  without effort support gets none: a request from the pinned CLI to `claude-haiku-4-5` with
  `--effort high` carried no effort field, and one to `claude-opus-5-5` did (seen in review of PR
  #118 against a local mock endpoint, not re-run here). The engine does not check model support.
- **Only reviewer files take it.** `effort` in `coordinator.md` or `shared.md` frontmatter has no
  effect, so the loader adds a setup warning that says to remove it, instead of ignoring it.
- **The no-tools fallback pass runs at `min(level, medium)`.** A timed-out pass is retried with no
  tools under a short cap (`maxToolCalls: 0`). A deep level there would likely time out again
  (found in a multi-model review of PR #118, not measured in a live run), and sending no level
  would use the provider's default, which can be higher than the agent's own `low` (OpenCode sends
  Gemini `high` by default; found in review of PR #119). So `fallbackEffort` caps the level at
  `medium` and never raises it, and `runClaudePrompt` passes that for the fallback. On OpenCode
  the fallback, and the finalize and corrective prompts, run at the agent's own level: OpenCode reads
  the level from the agent config, and ecr cannot know which lower levels a model takes (GPT-5 pro
  takes only `high`, per the provider's docs cited in review of PR #119), so it never sends a level
  the author did not write. An earlier version of PR #119 gave each such reviewer a
  `<id>__fallback-effort` copy at `min(level, medium)`; review showed it could send a rejected
  level, so it was removed.
- **An invalid level never stops a review.** `parseAgentEffort` returns a setup warning with the
  fix and no `effort`, so the agent runs at the default. The warning does not repeat the value: a
  backtick in it would close the code span in the review comment, and setup notes are not
  length-capped. The value is matched after trim and
  lower-case, and a trailing `# comment` makes it invalid like any other text.
- **Absent adds no key.** `LoadedAgent.effort` is set only when declared, so a setup without it
  keeps its review-cache key, and a setup that adds or changes it gets a fresh review.
- **Not handled here.** In a routed scope, a root `enforceAgents` entry replaces a same-id scope
  agent, but the scope keeps its own setup warnings: an invalid root `effort` shows no warning
  there, and an invalid scope `effort` warns about an agent that runs at the root's level. `mention`
  warnings behave the same way, so a fix belongs to all per-agent warnings at once. An unmatched
  quote (`effort: "max`) loads as `max`, because the shared frontmatter reader strips each quote on
  its own for every key.
- **`REVIEWER_MODEL` does not clear it.** The override can move an agent to another provider; the
  level then goes to that provider, or the note reports it as ignored.

## Budgets and Chunking Defaults

`budget.totalPassesMinutes` defaults to 55, not the scaffolded workflow's full 90-minute timeout,
to leave margin for the coordinator (~10m), verification, and git/gh overhead outside the passes
[observed: `schema.ts:160-165`]. `scopePassesBudgetMs` splits that total across active scopes,
which run SEQUENTIALLY in one `ecr ci` process, so the budget is divided across scopes, not spent
per scope [observed: `schema.ts:155-157`; `routing.ts:130-148`]. The even split is
`floor(total / active)`, clamped up to a 5-minute floor (`minScopeMinutes`); when the clamp wins the
floor is kept and an `overshoot` flag warns that the run will exceed the total, rather than starting
a scope in a window too small to be worth it [observed: `schema.ts:166-169`; `routing.ts:144-147`].
`activeCount` is floored at 1 (`Math.max(1, activeCount)`), so the budget is never divided by zero
and a run with no active scopes still gets a well-defined single-scope-equivalent budget
[observed: `routing.ts:144`]. This formula replaced an earlier unbounded per-scope minimum
(`max(10m, floor(32m/N))`) that let 4+ scopes collectively blow past the total
[observed: ROADMAP.md:60-69 "Recently shipped"].

Chunking is bounded by changed LINES (added + removed), not file count, because line count is what
dilutes model attention. `maxChangedLines` defaults to 1000, an explicitly-labeled heuristic (not a
measured optimum): most real PRs change well under that and get a single full-context pass, and the
cap keeps each chunk small enough that the reasoning-heavy correctness agent finishes within its
time cap; on real 50-file PRs a 1500-line chunk pushed correctness past 15 min. The comment carries
re-tuning guidance keyed to cap-hit and false-negative rates [observed: `schema.ts:21-44`].
`maxFiles` defaults to 20 as a secondary guard against a chunk of absurdly many tiny-diff files
[observed: `schema.ts:45-46`].

`chunk.concurrency` is deliberately left `undefined` in schema/load rather than defaulted here. It is
resolved later by `effectiveConcurrency` in `core/review.ts` from the auth mode (6 for API-key runs,
3 for a subscription/oauth credential), because one shared subscription credential handles six
parallel streams poorly and parks requests, producing a "stall" failure signature; an explicit value
always wins [observed: `schema.ts:47-53`; corroborated by commit `188f8521`]. Resolving it in this
subsystem would hardcode a value that can only be known once the credential mode is known.

## Loading and the Config-Dir Escape Hatch

`loadConfigDir` is the single shared loader for both root and scope config; the schema is passed as a
parameter (`ReviewConfigSchema` vs `ScopeReviewConfigSchema`) so root and scope loading share exactly
one code path, and `loadReviewConfig` with `ReviewConfigSchema` is guaranteed byte-identical to
pre-scope-feature behavior [observed: `load.ts:67-85`]. Loading is total, never lazy or partial:
`coordinator.md` and a non-empty `agents/` directory must exist or loading throws, and every agent is
hardcoded to a read-only tool set (`read`/`grep`/`glob`/`list`) with no schema knob to grant
write/bash [observed: `load.ts:126-155`, `load.ts:22-23`].

`resolveConfigDir` is the escape hatch (graft 1): precedence is explicit param → `ECR_CONFIG_DIR` env
→ the repo's default setup dir [observed: `load.ts`]. **The default setup dir has two spellings** (0.15.0): `.expo-agents/code-review/` is the home — one `.expo-agents/` directory holds every Expo agent tool's per-repo files (this tool's and `@expo/verify`'s) instead of one root dot-directory per tool — and the pre-0.15 `.expo-code-review/` stays fully supported. `configDirFor(base)` returns whichever exists, new name first, and the new name when neither does; it is used for the root and for every scope directory, `ecr init` writes into an existing legacy directory rather than doubling it, the config-file sweep (`isConfigDirPath`) and the reference index accept both, and the CI templates upload `.runs/reviews.jsonl` from either location. `.agents/` was rejected as the shared name because Codex, Cursor, Gemini CLI and Copilot already scan `.agents/skills/`. `hasConfig` resolves the config dir the same way, so
`doctor`'s "no config" diagnostic can never disagree with what the loader actually reads
[observed: `load.ts:55-60`]. The override designates an alternate ROOT config dir, so `config.jsonc`
and `routing.jsonc` always travel together: `loadRoutingManifest` reads through the same
`resolveConfigDir` [observed: `routing.ts:16-24`]. This composition was once a real bug: the override
only half-composed (root config honored it, the routing manifest did not), so the two could load from
different directories, later fixed so both go through the escape hatch
[observed: ROADMAP.md:72 "--config-dir/ECR_CONFIG_DIR fully composes with routing"].

`hasScopeConfig` is the one place that deliberately does NOT go through `resolveConfigDir`. Scope
subtrees stay repo-root-relative, so `ECR_CONFIG_DIR` must redirect only the ROOT config dir, never a
scope's own subtree [observed: `load.ts:256-271`]. Its job is to give a scope newly introduced by a PR
a defined MISS behavior: review with the root config, with the scope config activating only after
merge, instead of failing CI on exactly the PR that adds the scope. `ecr ci` runs this check against
the TRUSTED BASE root, not the PR head [observed: `load.ts:259-262`; commit `601b19a`;
`src/commands/ci.ts:547-552`]. Reusing `resolveConfigDir` here "for consistency" would let
`ECR_CONFIG_DIR` redirect scope subtree resolution, which is forbidden.

`loadAuthFromRoot` is the one place auth is honored: the manifest's `defaults.auth` wins when present,
otherwise the root `config.jsonc` auth; a scope config can never contribute auth (the scope schema
rejects it outright), so the secret-forwarding surface stays a single root-owned value no matter how
many scopes exist. The manifest default OVERRIDES root auth entirely, it never merges
[observed: `load.ts:235-250`]. `normalizeAuth(undefined)` always returns the single default entry
`[{ provider:'openai', mode:'api-key' }]`, never an empty array [observed: `load.ts:197-199`].

The JSONC reader is a minimal custom scanner (`stripJsonComments`/`stripTrailingCommas`), not a
library. That is an accepted tradeoff precisely because config is TRUSTED: it is in-repo and, as of
commit `601b19a`, always read from the PR's immutable base commit, so a light scanner suffices
[observed: `load.ts:367-369`]. The loader itself is agnostic to which root it is pointed at; the
trusted-base-vs-head decision is enforced by the caller in `ecr ci`, documented in
[LLP 0001](0001-trust-model.principles.md) and [LLP 0007](0007-cli-commands-and-ci.explainer.md),
and template/CI sync is the subject of [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md).
