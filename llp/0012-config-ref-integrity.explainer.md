# LLP 0012: Review-Setup Ref Integrity

**Type:** Explainer
**Status:** Active
**Systems:** Engine, CLI
**Author:** Philippe Loulidi / Claude
**Date:** 2026-08-03
**Related:** [LLP 0006 Config Schema, Loading, and Routing](0006-config-schema-loading-routing.explainer.md), [LLP 0007 CLI Commands and CI](0007-cli-commands-and-ci.explainer.md), [LLP 0009 Adoption Templates and CI Workflows](0009-adoption-templates-and-ci-workflows.guide.md)

A repo's reviewer prompts are full of citations into its own code: "the only session
entry point is `server/www/src/utils/session.ts`", "every webhook router must call
`sanitizeSecretPatterns`". Those citations are load-bearing — they are how a prompt
carries repo knowledge the model does not have — and nothing kept them true. Code
moves, symbols get renamed, and the prompt keeps citing a path that no longer exists.
The reviewer then reasons from a fiction, silently, on every PR.

`ecr ref-check` (`src/commands/ref-check.ts`, over `src/core/config-refs.ts`) closes
that gap: every code citation in a `.expo-code-review/` setup must be a ref, and every
ref must resolve against the checkout. It is deterministic — no model, no network —
in the same family as `ecr verify-config` (see [LLP 0007][verify]).

Two measurements motivated the strict form. Swept against a real adopting monorepo
(universe) the check found 165 citations, none of them annotated or verified by
anything; swept against this repo's own setup it found 24 [observed]. Not one of those
citations was checked before this existed.

## The `@ref` Grammar

One grammar, reused from the engine's own LLP annotations, so an author learns it once:

    @ref <target> [relation] — why it matters

In markdown it lives in an HTML comment, in JSONC after `//`. Targets:

| Target | Resolves when |
|---|---|
| `path/to/file.ts` | the file exists |
| `path/to/dir/` | the directory exists (trailing slash is required) |
| `path/to/file.ts#symbolName` | the file exists and still contains that whole word |
| `path/to/doc.md#heading` | the file exists and has that heading |
| `glob:**/Handler.kt` | at least one file in the repo matches |
| `https://…` | shape only, never fetched |

Refs are **always repo-root-relative**, including inside a scope's setup dir. A scope's
prompts describe the same tree the reviewer sees in the diff, so a second base
directory would only create ambiguity about which one a ref meant. Scoped prompts do
naturally cite their own subtree (`general-central/module` for
`infrastructure/general-central/module`), so that stays a broken ref — but the message
resolves it against the scope root and names the root-relative form to use.

`glob:` exists for readability. A Kotlin path 90 characters deep gets abbreviated in
prose (`.../config/MetricGroupCounter.kt`) and an abbreviation cannot be resolved, so
the check suggests the suffix glob `glob:**/config/MetricGroupCounter.kt` — short in the
prompt, still verified.

**Invariant:** a target is data, never a command. Resolution reads files inside the repo
root only, via the same `pathInside` confinement the verifier uses ([LLP 0005][verify5]);
absolute paths and `..` escapes are refused, not resolved.

## No Line Numbers, Symbol Anchors Instead

A ref may not pin a line. `src/auth.ts:42` is refused in an annotation *and* in prose,
because a line number is the one form of citation that rots without any signal: insert
a line above it and the ref still "resolves", now pointing at unrelated code. `#symbol`
is the robust alternative — it survives the code moving inside its file, and breaks
exactly when the thing cited is renamed or deleted, which is when a human should look.

For the same reason there is no content hash or pinned revision in the grammar. A digest
would trip on every edit to the cited file, including edits that leave the prompt
perfectly correct, and a check that cries wolf gets disabled. The drift signal lives on
the review side instead (below).

## Unannotated Citations Are Broken Refs

Checking only what an author annotated would make the mechanism decorative: the stale
citations are precisely the ones nobody thought about. So a backticked token in a setup
file that *looks like* a repo path and is not a ref fails the check.

That rule needs a precise notion of "looks like a path", because prompts also backtick
config keys, severities, commands and model ids. It comes in two tiers.

**Shape alone** (`isCodeCitation`): an allowlisted source extension, a trailing slash, or
a wildcard tail inside a path — and never whitespace, `:`, `<`, `(` or quotes. So
`session.ts`, `src/entities/oauth/` and `.github/workflows/**` are citations, while
`ecr ci`, `label:<agent>`, `knex.raw()`, `critical` and a bare `.ts` are prose. Fenced
code blocks are skipped whole: they are examples, not claims about the tree.

**Shape plus the filesystem** (`pathishCandidates`), for the citations shape cannot
settle. A reviewer of this feature named the case: a Terraform prompt citing
`eas-build-worker/terraform`, `general-central/{module,production}` and `finops`, with
"this is very likely going to drift" [observed] — not one of those has an extension, and
`anthropic/claude-opus-5` is shaped identically while naming no file. Syntax cannot tell
them apart, so an extensionless token counts as a citation exactly when it *names
something real*: probed against the repo root and the scope's own subtree, brace lists
and wildcards cut back to their fixed prefix. Model ids resolve to nothing and stay prose.

The consequence is deliberate: an extensionless path that had already drifted before
adoption is invisible (nothing distinguishes it from prose), while every one that is true
today gets pinned and will be caught the moment it moves. This mechanism prevents future
drift; it does not retroactively find old drift.

The escape hatch is explicit and per-token: `@ref-ignore knex.raw()` in a comment.
Anything the heuristic misclassifies is one short line away from silence, which is why
the rule can afford to be strict rather than advisory.

**Invariant:** the check never rewrites a prompt. It reports; a human decides whether the
ref or the prompt was wrong. A stale citation often means the *guidance* is stale, not
just the path.

## Structural Refs Need No Annotation

Some refs the config already declares, so they are checked without annotation:
`enforceAgents` ids must exist as `agents/<id>.md` in the ROOT setup (that is where the
loader resolves them, see [LLP 0006][routing]), every scope's `config` must point at a
real `.expo-code-review/` directory inside the repo, and every scope glob must match at
least one file — a scope whose paths match nothing ships prompts that review nothing.

## What Gets Scanned

Setup dirs are found by walking the tree, not by reading `routing.jsonc`: a scope dir the
manifest forgot still ships prompts, and its stale refs are exactly what this exists to
surface — the same reason `ecr verify-config` sweeps on disk instead of trusting the
manifest ([LLP 0007][verify]). Inside a setup dir the scan covers prompts and configs
(`.md`, `.json`, `.jsonc`, `.txt`) and skips dot entries, so `.runs/` artifacts are never
scanned. Dot directories elsewhere are skipped too, which keeps `.claude/worktrees/`
checkouts of the same repo from being swept as if they were scopes.

## Run Points: Command and Review

`ecr ref-check` exits 1 on any problem: that is the gate, for CI or a pre-commit hook.

The review path also runs it, and never fails a PR's checks with it — that invariant
holds ([LLP 0002][pipeline]). Instead the review *advises*: broken refs in the setup
become a note the reviewer comment carries, and `citedPathsTouchedBy` adds the drift
signal a static check cannot give — "this PR changes code your reviewer prompts cite, so
the guidance may need updating" — even when the ref still resolves. In CI the config
comes from the trusted base ref while refs resolve against the PR head tree, so a PR that
moves cited code is reported against the config that will actually review it.

## Two Checkers, One Grammar

The engine repo now has two ref checkers, and they scan overlapping files: `./ref-check`
(the LLP corpus validator, which walks the whole tree) and `ecr ref-check` (setup dirs
only). Running both surfaced two genuine conflicts, where one checker failed an
annotation the other accepted [observed]:

- `glob:` targets were unknown to `./ref-check`, which read them as a literal path and
  reported "path not found".
- Documenting the syntax broke both: a usage line containing the comment form with a
  `<target>` placeholder was collected as a real ref, and so were the README's fenced
  examples — the docs that teach refs were the first thing the checkers rejected.

All of it is fixed in the grammar rather than per-checker: `glob:` is understood by both,
a target starting with `<` or a backtick is a documentation placeholder, and an annotation
inside a fenced code block is an example that neither checker resolves. `LLP NNNN` targets
stay owned by `./ref-check` — `ecr ref-check` skips them, since an adopting repo has no
LLP corpus.

**Invariant:** the grammar is shared. A change to target kinds, the placeholder rule, or
the glob dialect must land in `./ref-check` and `src/core/config-refs.ts` together, or the
same annotation will pass one checker and fail the other.

[verify]: 0007-cli-commands-and-ci.explainer.md#verify-config-the-config-guard
[verify5]: 0005-verification-fingerprints-rendering.explainer.md#verifier-confinement-and-fail-open
[routing]: 0006-config-schema-loading-routing.explainer.md#routing-manifest
[pipeline]: 0002-review-engine-pipeline.explainer.md#pipeline-stages
