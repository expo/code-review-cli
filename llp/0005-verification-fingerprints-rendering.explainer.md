# LLP 0005: Finding Verification, Fingerprints, Suppression, and Rendering

**Type:** Explainer
**Status:** Active
**Systems:** Engine, Reporters
**Author:** Philippe Loulidi / Claude
**Date:** 2026-07-30
**Related:** [LLP 0001 Trust Model and Security Principles](0001-trust-model.principles.md), [LLP 0002 Review Engine Pipeline](0002-review-engine-pipeline.explainer.md), [LLP 0004 Diff Intake, Noise Filtering, and Prompt Assembly](0004-diff-noise-and-prompts.explainer.md), [LLP 0008 Review Sources and Reporters](0008-sources-and-reporters.explainer.md)

This doc covers the last stage of the pipeline: the guard that decides which model-produced findings survive (`src/core/verify.ts`), the identity they are keyed by (`src/core/schema.ts`), the author-facing suppression backstop (`src/core/suppress.ts`), and how the whole thing becomes one GitHub comment (`src/core/render.ts`). The theme is a trust boundary: a Finding's `file`/`line`/`evidence` are LLM-authored strings written over untrusted PR content, and verification is [the only point where they become trusted enough to act on][agents]. Everything here is about not over-trusting that data, and not over-suppressing on it.

## Evidence Grounding: Escalate, Never Hard-Drop

The first design decision is that a quote mismatch is not a drop. `matchEvidence` grades a finding's `evidence` against the real file with exact-substring first, then fuzzy fragment matching (`evidenceFragments` splits on newlines and ellipses, strips copied `+`/`-` diff markers and `//`/`#`/`*` comment markers, normalizes, keeps fragments over the length floor). Exact match alone was measured to be a good positive signal but a poor negative one [observed]: it misfires on structural/absence bugs, cross-line quotes, ellipsis elisions, and copied markers (`verify.ts:30-42`, `verify.ts:44-69`).

The reason the fuzzy path exists at all is a reverted experiment. An earlier rule dropped any finding whose evidence was `absent` from the file. On ~13 real PRs that rule dropped 3 findings for every 1 it correctly suppressed, and at least one drop was a confirmed real bug (commit `33a970a`, message and `verify.ts:113-116`) [observed]. So `absent` is explicitly **not terminal** (`verify.ts:49-50`): it escalates to an adversarial LLM verifier that re-reads the real file and judges the underlying problem, rather than deciding on the quote. `verify.test.ts:95-105` is the named regression guard for this — "an imperfect/absent quote must not be a silent drop."

Two more grounding rules follow from the same caution:

- **Criticals always get the skeptical double-check.** The LLM verify call runs when evidence is `absent` OR severity is `critical`, even a perfectly grounded critical (`verify.ts:98-107`, `verify.ts:137`). Grounded, non-critical findings take the fast path and are kept with no LLM call.
- **Short evidence concludes `unknown`, never `absent`.** Below `MIN_EVIDENCE_LEN` (12 normalized chars) `matchEvidence` returns `unknown` (`verify.ts:55-59`), so trivially short text can never look like a grounding failure and trigger the escalate-or-drop path. `verify.test.ts:46-49` guards this. The verifier prompt itself is told to [judge the substance, not the wording][judge], so paraphrased or misquoted evidence cannot by itself cause a rejection (`prompts.ts:305-310`).

**Invariant:** `matchEvidence` never returns `absent` for evidence under 12 normalized chars. Do not "simplify" it back to a plain exact-substring check — that is the reverted `33a970a` design.

## Verifier Confinement and Fail-Open

`finding.file` is attacker-influenced. A prompt-injected finding could set it to an absolute path (`~/.claude/.credentials.json`) or use `..` to escape the reviewed tree, and `path.resolve` silently ignores `cwd` for absolute inputs and does not block `..`. `evidencePresence` therefore confines every read to `cwd` with `pathInside` before any `readFile` (`verify.ts:73-90`), the shared trust-boundary primitive from `src/core/exec.js` (see [LLP 0001][trust]). This was hardened in commit `93aaf30` [observed].

The subtle part: the confinement blocks the read **and the verdict**. Even the bare `present`/`absent` grading for an out-of-tree file must not be computed, because that one bit is a content-oracle leaking host-filesystem information back into an attacker-influenced flow (`verify.ts:81-83`). So out-of-tree paths return `unknown` (uncheckable), never a grading. `verify.test.ts:125-185` asserts zero LLM escalation on absolute-path and `..`-escape inputs as the observable signal that no read happened.

The verifier prompt is a second confinement concern. `buildVerifierSystem` is [deliberately NOT wrapped][sanitize] in the shared injection-defense rules that reviewer prompts get; instead `buildVerifierTask` neutralizes the finding's `title`/`rationale` per-field through `sanitizeUntrusted`/`flattenUntrusted` so an injected finding cannot forge verifier prompt boundaries (`prompts.ts:333-349`, also `93aaf30`). Removing those calls while refactoring reopens that hole.

Confinement is paired with **fail-open**: any error or timeout in a verify call keeps the finding (`verify.ts:177-183`). A possible false positive is preferable to silently hiding a real finding on an infra hiccup, and it aligns with the "ecr CI must never fail a PR's checks" principle. The consequence to keep in mind: a broken verifier engine lets all escalated findings through unfiltered, not zero — an agent "fixing" this to fail closed would start suppressing findings on any transient failure.

**Invariant:** a finding is dropped ONLY when the verifier explicitly refutes it (`value.verified === false`). `verify.ts:170-172` is the sole `drop` site in the file. Order is preserved: `kept` filters the original `findings` array, not the verify-resolution order (`verify.ts:188`), so which findings happened to need an LLM call never perturbs downstream ordering.

## Finding Identity: Fingerprints

A finding's fingerprint is the key for dedup across re-reviews and for `/dismiss`. Two choices in `fingerprintFinding` (`schema.ts:119-134`) are load-bearing:

- **Key on the verbatim `evidence` snippet (v2), not the title.** Instability was found while designing dismissal: titles vary run-to-run even at temperature 0.1, so a dismissal keyed on the title would silently lapse and the finding would re-surface. ROADMAP flagged it "Must fix before building dismissal" and it was re-keyed to `sha1("v2"|file|category|normalizeCode(evidence))` [observed] (ROADMAP.md:800-801; `schema.ts:130-133`). It falls back to the title only when evidence is under 12 normalized chars.
- **Exclude the line number.** Line numbers shift as a PR grows; including one would churn a finding's identity and lapse its dismissal on every push (`schema.ts:121-122`). Do not add it back "for precision."

`scopedFingerprint` (`schema.ts:136-150`) namespaces fingerprints per monorepo scope so cross-scope dismissals never collide, with one back-compat carve-out for **risk 9**: the default scope passes `null` and keeps the plain, unmodified fingerprint, so dismissals created before a repo adopted `routing.jsonc` still resolve after adoption. Non-default scopes hash into the same hex alphabet and length the dismiss command sanitizes user ids to (`dismiss.ts` strips `/[^a-f0-9]/`), so a scoped id always survives round-tripping through that input sanitizer. `render-aggregate.test.ts:105` guards the default-scope carry-over.

Note the stateless coupling: prior comments, findings, and dismissal state are [never fed back into the review agents][trust] — every run is stateless over (diff + repo + PR title/body). Suppression and dedup are a post-agent display concern precisely so an agent can never be anchored by, or biased into hiding a finding via, a previous run or an existing dismissal.

## Inline Suppression Backstop

`applyInlineIgnores` (`src/core/suppress.ts`) is the deterministic backstop for the `expo-code-review-ignore` directive. The directive used to be prompt-only: a grep found zero code references, so suppression depended entirely on the model choosing to obey it [observed] (ROADMAP.md:802; `suppress.ts:15-19`). Now the directive on the flagged line, or the line directly above it, deterministically drops the finding.

The absolute constraint is the carve-out (`suppress.ts:39-44`): a `critical` or `secrets`-category finding is **never** suppressed this way — an author could otherwise hide a real vulnerability in their own PR with a single comment line. This is one instance of the corpus-wide rule that a critical/secrets finding is never silently erased by any suppression mechanism except the explicit `/skip-review` escape hatch; everything else is a display filter, reversible and auditable, never a review skip (see [LLP 0001][trust]). Suppression runs against files under `cwd` (the materialized PR-head read root, see [LLP 0008][sources]).

## Comment Rendering

`render.ts` is a pure Markdown builder — no I/O, no GitHub calls, consumed only by `src/reporters/github.ts` (see [LLP 0008][sources]). Its correctness rules are all about GitHub's Markdown/HTML parser and about being the durable state store.

**Links are only ever real.** `location()` (`render.ts:108-140`) links a finding to its diff position (`#diff-<sha256(path)>R<line>`) ONLY when that exact file+line is in `buildDiffLineIndex`; otherwise it links the source blob at the PR **base commit SHA** (`/blob/<sha>/<path>#L<line>`), and only falls back to plain text when there is no base SHA. Findings on unchanged code the PR merely references used to get dead diff anchors (commit `f9fecd5`) [observed]. The base target is a commit SHA, not a branch name, so the permalink does not drift as the base advances after posting (`render.ts:21-29`). Config-controlled comment tags are regex-escaped before any RegExp is built from them, so a tag with metacharacters can't corrupt the match (`render.ts:271-272`, `render.ts:500`).

**Multi-line rationales stay inside their list item.** `indentContinuation` (`render.ts:233-248`) indents *every* continuation line to the list-item content column, not just the first. When a rationale embeds a `<details>` block and only the first line was indented, GitHub treated the closing `</details>` as ending a top-level HTML block and rendered the *next* finding's bullet as raw text — every finding after the first in a severity group leaked raw `**` and backticks. This was observed on `brentvatne/euxy#45` and fixed in commit `30a9e3e` [observed]. Blank lines must stay truly empty: padding them with the indent prefix makes them non-blank to Markdown and reopens the same HTML-block-escape bug. `renderFindingLines` also appends a trailing blank line after every finding as a hard separator so a rationale ending in `</details>` can't swallow the next bullet.

**The comment is the durable store.** An embedded `<!-- tag:state=... -->` comment holds base64 JSON of the FULL review plus dismissals — not just what is rendered — so a later `/dismiss` or `/undismiss` can re-render without re-running the engine (`render.ts:198-202`, `encodeState`/`parseReviewState` at `render.ts:493-513`). There is no side-channel database; the comment body is the state. Dismissed findings render in a collapsed `<details>` section, disjoint from the active list (a finding is never in both), keeping the main list clean while preserving a `by`/`reason` audit trail.

**The coverage note only cries wolf when there is a wolf.** The partial-coverage warning renders only when `review.incomplete` is non-empty (`render.ts:166`) — the aggregate renderer additionally triggers it when unmatched files exist (`render.ts:373`) — a deliberate anti-noise choice so the warning is trustworthy when it appears (`render.test.ts:34`). The advisory footer ("never blocks a merge and never auto-approves") is duplicated verbatim across both renderers because it is a required trust-boundary claim, not incidental text.

## Truncation and Aggregate State

`renderAggregateMarkdown` folds multiple monorepo scopes into one comment under the single marker. GitHub's body limit is treated as ~65k chars and the renderer keeps a margin at `MAX_COMMENT_CHARS = 60_000` (`render.ts:316-317`). When a body overflows, it trims each scope's KEPT findings to the most-severe N, halving until it fits with a floor of 3 (`render.ts:480-489`). The first truncation step seeds N from `largestScope / 2` rather than an arbitrary constant, so it lands close to the needed size in one step instead of wasting iterations.

The invariant that makes this safe: **dismissed findings always survive in full in the embedded state, regardless of truncation** (`render.ts:449-459`). Truncation trims only the shown/kept set; the state blob still carries every dismissed finding so `/undismiss` never permanently loses a dismissal (`render-aggregate.test.ts:117-137`). An agent "simplifying" truncation to also drop dismissed entries would break `/undismiss`.

The state blob is deliberately dual-shaped: it keeps a synthesized v1-shaped `review` field (a merge across scopes) beside the real per-scope `scopes` field, so older consumers expecting the pre-routing v1 shape keep parsing while v2 consumers read real per-scope data (`render.ts:293-300`, `render-aggregate.test.ts:88-103`). `renderSeveritySections` is the single shared display path for both the single-comment and aggregate renderers, with `SEVERITIES`/`SEVERITY_RANK` as the sole ordering source of truth, so the two renderers cannot drift.

[agents]: 0000-expo-code-review-cli.explainer.md
[trust]: 0001-trust-model.principles.md
[sources]: 0008-sources-and-reporters.explainer.md
[judge]: 0004-diff-noise-and-prompts.explainer.md
[sanitize]: 0004-diff-noise-and-prompts.explainer.md
