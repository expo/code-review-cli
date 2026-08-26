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
tests each `**/`-prefixed pattern in two variants (with and without the prefix stripped) to give the
catch-all its conventional "zero or more directories" meaning [observed: `routing.ts:57-73`]. The
"proper" fix lives in `matchesIgnore` itself, whose blast radius covers noise filtering too, so the
workaround stays local.

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
