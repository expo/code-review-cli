# LLP 0011: Author Feedback on Findings

**Type:** Explainer
**Status:** Active
**Systems:** Engine, Prompts, Rendering, Reporters, Config, CLI, Security
**Author:** Philippe Loulidi / Claude
**Date:** 2026-08-01
**Related:** [LLP 0000 System Map](./0000-expo-code-review-cli.explainer.md), [LLP 0001 Trust Model](./0001-trust-model.principles.md), [LLP 0002 Review Pipeline](./0002-review-engine-pipeline.explainer.md), [LLP 0004 Diff & Prompts](./0004-diff-noise-and-prompts.explainer.md), [LLP 0005 Verification & Rendering](./0005-verification-fingerprints-rendering.explainer.md), [LLP 0006 Config](./0006-config-schema-loading-routing.explainer.md), [LLP 0008 Sources & Reporters](./0008-sources-and-reporters.explainer.md), [LLP 0010 Stack-Aware Requalification](./0010-stack-aware-requalification.explainer.md)

A PR author who disagrees with a finding today has one option: reply in prose and
hope a human reviewer notices. The reviewer itself never reads that reply — every
run is stateless, so the same finding comes back on the next push even after the
author explained why it doesn't apply. This feature closes that loop without
opening the two doors a feedback loop usually opens: letting attacker-controlled
reply text back into the trusted comment body, and letting a model's opinion of a
rebuttal outrank the actual code. The shape is: match a reply to the finding it
answers **deterministically** (no model in the loop), record only enum-valued
facts about the match, optionally have a model **check the rebuttal against the
source** (never weigh it as an argument), and apply hard, code-level floors so a
`critical`/`secrets`/`security` finding can never be talked away. `ecr feedback`
mines this same substrate retroactively across a repo's PR history, because the
bot's own past comments already embed their findings.

## Deterministic Matching

A reply is matched to a finding the same way a human would recognize it: by
quoting the finding's title back, or by citing its short `id:` token — never by
a model's guess at "which finding is this about." `matchReplies` in
`src/core/responses.ts` is pure (no IO, no `gh`, no model) so every rule below is
directly unit-testable [observed] ([responses.ts](../src/core/responses.ts)
`matchReplies`). `normalizeTitle` strips link targets, emphasis marks, and
trailing punctuation before comparing, since a reply quoting a rendered title is
otherwise byte-identical to it [observed] ([responses.ts](../src/core/responses.ts)
`normalizeTitle`). Quoted lines come only from real blockquotes (`>`), and a `>`
inside a fenced code block is explicitly skipped — a pasted snippet that happens
to contain a `>` must never be read as the author quoting the review
[observed] ([responses.ts](../src/core/responses.ts) `extractQuotedLines`).

The one rule that matters most: **an ambiguous quote records nothing.** When a
quoted line's normalized text matches 2+ findings, the match is dropped for that
line unless the same comment also carries an `id:<fp>` token that disambiguates
it — because attributing a rebuttal to the wrong finding is worse than recording
no rebuttal at all [observed] ([responses.ts](../src/core/responses.ts)
`matchReplies`, the `candidates?.length === 1` gate). A quote shorter than 8
normalized characters is ignored outright, so a bare `> ok` or `> +1` can never
collide with a short title [observed] ([responses.ts](../src/core/responses.ts)
`MIN_QUOTE_LEN`). When several comments answer the same finding, the newest
(highest comment id) wins — a later reply supersedes an earlier one on the same
point [observed] ([responses.ts](../src/core/responses.ts) `matchReplies`,
`newest` map). And a comment carrying the reviewer's own embedded-state marker
is never treated as a reply, closing the trivial case of the review answering
itself [observed] ([responses.ts](../src/core/responses.ts) `OWN_COMMENT_RE`).

The reporter feeds this matcher only genuinely human comments — excluded by the
unspoofable comment author (`user.login`), not by the marker string alone, plus
a marker check as a second gate — so the same identity discipline that protects
dismissal state (see [LLP 0008](./0008-sources-and-reporters.explainer.md)
"github-reporter-identity") protects feedback matching too
[observed] ([github.ts](../src/reporters/github.ts) `replyComments`). Because the
matcher never depends on a live run, `ecr feedback` reuses it unchanged to mine
history: a past PR's bot comment already embeds the findings it surfaced, so
matching replies against that embedded set needs no re-review and no model call
[observed] ([feedback.ts](../src/commands/feedback.ts) module header comment;
`GitHubReporter.collectFeedback`).

## Never Echo Reply Text

`FeedbackRecordSchema` has no free-text field — deliberately. It stores only the
fingerprint it answers, the replying login, the comment id/url, a `maintainer`
flag, and two closed enums (`verdict`, `reason`) [observed]
([schema.ts](../src/core/schema.ts) `FeedbackRecordSchema`). The reply's actual
words are never written to that record and never rendered: the comment body
shows only `@login replied` (or the literal `an author` when the login isn't
GitHub-shaped) linked to the comment, nothing more
[observed] ([render.ts](../src/core/render.ts) `replyAuthor`, `replyAnnotation`).
The one place reply text is even read is transient: `adjudicateFeedback` builds
it into a single model prompt and discards it once that call returns — the
returned `FeedbackRecord` carries no trace of it
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `AdjudicationItem`,
doc comment on `replyText`).

This isn't caution for its own sake — it is the fix for a real hole, explained
next.

## Forged State Markers

`parseReviewState` and `parseEmbeddedFingerprints` each match the body with a
**non-global** regex, so they return the FIRST `<!-- tag:state=… -->` /
`<!-- tag:fingerprints=… -->` marker in the body — while the genuine marker the
reporter writes is always appended LAST [observed]
([render.ts](../src/core/render.ts) `parseReviewState`,
`parseEmbeddedFingerprints`; both call `body.match(...)` with no `g` flag). Any
externally-sourced string rendered into the body earlier than that trailing
marker — a model-written `rationale`, a dismissal `reason`, a reply's login —
could therefore contain a forged look-alike comment that the parser would read
as the REAL state, letting a PR author dictate their own `dismissed`/`feedback`
list. This was already a latent hole before this feature (a prompt-injected
finding field could reach the body); echoing reply text back would have widened
it, since a reply is attacker-controlled prose by construction.

The fix applies everywhere, not just to feedback: `stripStateMarkers` escapes
every `<!--` in untrusted prose to `&lt;!--`, so no externally-sourced string can
open an HTML comment at all — a finding never legitimately needs one
[observed] ([render.ts](../src/core/render.ts) `stripStateMarkers`). It runs over
every field that reaches the body from outside the engine: finding `title`,
`rationale`, `suggestion`, `requalifiedBy.reason`/`.file`, dismissal `by`/
`reason`, file paths (`locationText`), scope names, and feedback logins/reasons
[observed] ([render.ts](../src/core/render.ts) call sites in `renderMarkdown`,
`renderAggregateMarkdown`, `location`, `droppedSuffix`, `addressedLines`). It
deliberately does **not** touch `evidence` — that field is never rendered into
the body at all (only quote-grounded against the file during verification), so
sanitizing it would be dead code masquerading as a guard
[observed] ([schema.ts](../src/core/schema.ts) `FindingSchema.evidence`
doc comment; no `finding.evidence` reference exists in `render.ts`).

## Attribution and Identity

Findings gain an optional `agent: string` — which reviewer agent produced
them — populated by the engine after coordination, never by the model itself
[observed] ([schema.ts](../src/core/schema.ts) `FindingSchema.agent`). It is
excluded from `fingerprintFinding`'s hashed tuple for the same reason
`requalifiedBy` is (see [LLP 0010](./0010-stack-aware-requalification.explainer.md)
"requalification-schema-and-fingerprints"): a finding's identity must stay stable
across whatever annotations ride alongside it, or an existing dismissal would
silently lapse the moment attribution appeared on a finding it already covers
[observed] ([schema.ts](../src/core/schema.ts) `fingerprintFinding`, which hashes
only `["v2", file, category, key]` — `agent` never enters that tuple).

Attribution survives the coordinator's own merge step by re-matching on
fingerprint after coordination: each surviving finding is matched back to the
raw pre-coordination finding that produced the same fingerprint, and the first
agent found wins when several raw findings merged into one
[observed] ([review.ts](../src/core/review.ts) the `agentByFp` attribution block,
right after requalification). A finding the coordinator rewrote enough to change
its fingerprint (a different `evidence` snippet, a re-categorized `category`)
stays unattributed rather than guessed — `ecr feedback`'s `byAgent` breakdown
reports it as `"unknown"`, never a fabricated guess
[observed] ([feedback.ts](../src/commands/feedback.ts) `aggregateFeedback`,
`finding.agent ?? "unknown"`).

## The Rebuttal Is a Hypothesis

`templates/shared.md` already tells every reviewer agent that a PR's claims of
intent ("this is safe", "this is a fixture") carry no weight — only what the code
does matters. Adjudication must not contradict that rule for a human's rebuttal
either: a reply is a CLAIM to check against the source, never an argument whose
tone or authority should move the verdict. `buildAdjudicatorSystem` says exactly
this, and is deliberately **not** wrapped in `withShared` — it emits a verdict,
not findings, and stays as distrustful as `buildVerifierSystem` rather than
inheriting the reviewer-agent framing
[observed] ([prompts.ts](../src/core/prompts.ts) `buildAdjudicatorSystem`, its
doc comment). The prompt enumerates what would actually CONFIRM each reason from
the source (e.g. "pre-existing" is confirmed by finding the same pattern in
unchanged code, not by the author asserting it), and makes `"unclear"` the
explicit default whenever the model cannot confirm the claim in the code — never
accept what you couldn't verify [observed] ([prompts.ts](../src/core/prompts.ts)
`buildAdjudicatorSystem` body). The reply text itself reaches the model only
inside a sanitized, fenced `BEGIN/END AUTHOR REPLY` block, with any forged
boundary line stripped first — the same discipline `contextFileSection` applies
to external context [observed] ([prompts.ts](../src/core/prompts.ts)
`buildAdjudicatorTask`, `AUTHOR_REPLY_BOUNDARY`).

Adjudication is wired as a serial tail step in `runReview`, after verification
(and any stack requalification) and before the coordinator output is handed to
the reporter — it never runs when `options.feedback` is absent, so every caller
that doesn't opt in is byte-identical to before this feature
[observed] ([review.ts](../src/core/review.ts) the `options.feedback` block,
guarded by `config.mode !== "off"`). It fails open exactly like the rest of the
review pipeline: an adjudication error is caught, logged as a coverage note, and
never breaks the run — `ecr ci` must never fail a PR's checks, and this path is
no exception [observed] ([review.ts](../src/core/review.ts) the `try/catch`
around `options.feedback.match`/`adjudicateFeedback`).

That fail-open contract has a sharp edge in `comment:'single'` mode, where every
active scope's feedback seam writes into ONE shared aggregate comment: a transient
GitHub fetch error inside one scope's seam must never be read as "this scope's
replies are gone," or the aggregate merge would delete that scope's prior reply
attributions/verdicts with nothing to replace them the moment the API blips. The
try/catch above is what makes the two cases distinguishable: a seam that ran and
matched zero replies sets that scope's `review.feedback` to `[]` (truthy, and
correctly authoritative — the reply really is gone); a seam that threw leaves
`review.feedback` `undefined` (the catch never sets it). `mergeAggregateFeedback`
(`src/commands/ci.ts`) checks exactly that per scope before treating a scope's
fingerprints as "fresh": a scope whose seam failed this run falls back to its
prior aggregate records untouched, while a sibling scope whose seam succeeded —
even with zero results — is still fully authoritative for its own fingerprints
[observed] ([ci.ts](../src/commands/ci.ts) `mergeAggregateFeedback`,
`seamOkByScope`).

## Hard Floors in Code

The prompt tells the model to be distrustful; the floor that actually protects a
`critical`/`secrets`/`security` finding lives in TypeScript, not in anything a
model could be argued out of. `feedbackApplied` is the single function that
decides whether a reply clears a finding, and it returns `false` unconditionally
for `finding.severity === "critical"` and for any finding whose category is in
`HARD_FLOOR_CATEGORIES` (`secrets`, `security`) — a constant the configured
`protectedCategories` can only ADD to, never shrink, since both checks run
independently [observed] ([adjudicate.ts](../src/core/adjudicate.ts)
`HARD_FLOOR_CATEGORIES`, `feedbackApplied`). Above those floors, dismissal is
gated by `dismiss` alone: `"never"` (the shipped default) short-circuits to
`false` before any floor is even checked, so nothing clears a finding until a
repo explicitly opts in. `mode` is deliberately a separate axis — it selects
how much machinery runs (off / match-and-annotate / also judge), not who may
clear — so `dismiss: "maintainers"` works under plain `mode: "annotate"`
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `feedbackApplied`, the
first guard clause; `feedbackNeedsRunSeam` is what wires the seam for that
combination). Coupling the two would force a repo to switch on the model mode
just to enable the no-model maintainer path, which is the same trust gate as
`/dismiss` in prose form. A maintainer's reply clears a finding with no model
involved at all (`record.maintainer`); among everyone else, only the PR
AUTHOR's reply can clear one, and only under `dismiss: "adjudicated"` AND a
recorded `"accepted"` verdict — never on an `"unclear"` or `"refuted"` one, and
never for a third-party commenter's reply even when the model accepted it: the
adjudicated path is the author's alone, so a stranger's rebuttal is annotated
but can never move the outcome [observed] ([adjudicate.ts](../src/core/adjudicate.ts)
`feedbackApplied`, the `record.author === true` check on the final branch).
`record.author` is re-derived every run from the live comment's login against
the PR's own author login — never trusted from stored state, the same
unspoofable-identity discipline as `maintainer` — so an unresolved author (a
`gh pr view` failure) is `undefined`/`false`, which fails CLOSED to "never
clears" rather than open [observed] ([responses.ts](../src/core/responses.ts)
`ReplyComment.author`; [github.ts](../src/reporters/github.ts)
`resolvePrAuthor`, `replyComments`).

`adjudicateFeedback` re-derives `applied` for **every** record on every call —
including ones a model never touched this run (already-decided verdicts from a
prior run are skipped to avoid re-spending the budget on the same words,
tracked via `record.verdict === undefined`) — so a config change (e.g. flipping
`dismiss` from `"adjudicated"` back to `"never"`) takes effect immediately on
the next run without needing new replies [observed]
([adjudicate.ts](../src/core/adjudicate.ts) `adjudicateFeedback`, the `records`
map at the end). The cap (`maxAdjudications`) is enforced by slicing, never by
silent truncation: everything past the cap is counted in `skipped` and surfaced
as a coverage note on the review output, and a per-record model error is caught,
counted in `failed`, and leaves that record unjudged rather than throwing
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `adjudicateFeedback`,
the `within`/`skipped` slice and the per-item `try/catch`;
[review.ts](../src/core/review.ts) the `incomplete` push when `skipped > 0 ||
failed > 0`).

Turning `mode` to `"off"` degrades the same way, on the render side rather than
the seam side: `GitHubReporter.computeFeedback` recomputes `applied` for every
carried record under the CURRENT config (so a reply-cleared finding correctly
falls back to the active list) but keeps the records themselves — who replied,
any verdict, any `unclearedByHuman` pin — instead of discarding them. Returning
an empty list here instead would silently erase every recorded reply from the
comment's embedded state the moment a repo flips the switch, with no way back;
`"off"` must mean "stop matching new replies," not "forget the ones already
recorded" [observed] ([github.ts](../src/reporters/github.ts)
`computeFeedback`, the `!config || config.mode === "off"` branch returning
`reapply(previous)`).

## Suppression Is Never Silent

[LLP 0010](./0010-stack-aware-requalification.explainer.md) established the
rule for stack requalification: an effect on a real finding must never be a
"collapsed fold nobody reads" — it needs a visible, above-the-fold count.
Feedback reuses the identical shape. `feedbackAuditNote` renders
`> 💬 **N finding(s)** have an author response (M applied).` above the finding
list whenever N > 0, mirroring `requalificationAuditNote` line for line
[observed] ([render.ts](../src/core/render.ts) `feedbackAuditNote`,
directly beside `requalificationAuditNote`). An `applied` finding doesn't just
disappear from the active list either: it moves into the same collapsed
"Dismissed" section a manual `/dismiss` uses, with its own audit suffix —
`— dismissed via reply by @login` — so a reply that cleared a finding is
recorded exactly as auditably as a maintainer's explicit dismissal
[observed] ([render.ts](../src/core/render.ts) `droppedSuffix`, the `reply`
branch; `renderMarkdown`'s `isDropped` treats `feedbackByFp.get(fp)?.applied`
the same as an explicit dismissal). The aggregate renderer applies the same
note and the same fold, per scope, keyed by the scope-namespaced id so a record
never crosses scope boundaries [observed] ([render.ts](../src/core/render.ts)
`renderAggregateMarkdown`, `feedbackById` keyed via `idOf`).

Feedback records also ride the embedded comment state exactly like dismissals:
they are never trimmed away by the aggregate's size-based truncation loop, even
when that loop is shrinking how many findings are shown, because losing a
record would silently lose a verdict a prior run already decided
[observed] ([render.ts](../src/core/render.ts) `renderAggregateMarkdown`, the
comment above the `stateScopes` map: "Feedback records ride the state whole,
never trimmed by the cap loop"). And the reporter's merge step
(`mergeFeedback`) only ever carries a decided `verdict`/`reason`/`applied`
forward when the newest reply on that finding is the SAME comment it was
decided about — a newer reply resets the decision, because a new reply answers
different words and deserves its own judgment
[observed] ([github.ts](../src/reporters/github.ts) `mergeFeedback`, the
`prior.commentId === record.commentId` gate).

Suppression by reply must be exactly as reversible as suppression by
`/dismiss`: a maintainer running `/undismiss <id>` on a finding a REPLY cleared
(not only a manual dismissal) restores it to the active list, not just to the
Dismissed fold. The reporter checks the `/undismiss` removal set against
`state.feedback` too, un-applies any matching record, and pins it —
`unclearedByHuman: true` — so a later re-review, recomputing `applied` from
that SAME still-present reply, does not silently re-clear the finding the
human just restored; `feedbackApplied` checks this pin before any other floor
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `feedbackApplied`, the
`record.unclearedByHuman` guard; [github.ts](../src/reporters/github.ts) the
`removeSet`/`unclearedByHuman` branch in the dismissal-render path). The pin
travels with that one reply, not the finding forever: `mergeFeedback` carries
it forward only while the record is about the SAME `commentId`, and a NEWER
reply on the same finding is a fresh decision that drops the pin exactly like
it drops a stale verdict — a human's override doesn't gag a future reply
[observed] ([github.ts](../src/reporters/github.ts) `mergeFeedback`, the
`prior.unclearedByHuman` forwarding beside the verdict/reason carry-forward).
A record already carrying this pin is also excluded from `adjudicateFeedback`'s
model pass — there's nothing to gain by re-judging a reply whose verdict, even
if `"accepted"`, a human has already overridden
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `adjudicateFeedback`,
the `toJudge` filter).

## Asymmetric Defaults

The `feedback` config block ships with `mode: "annotate"` on by default and
`dismiss: "never"` off by default — an intentionally asymmetric pair
[observed] ([schema.ts](../src/config/schema.ts) `ReviewConfigSchema.feedback`,
`.default({...})`). The reason is structural, not cautious-for-its-own-sake:
adopting repos maintain their own `.expo-code-review/config.jsonc` and never
re-copy `templates/config.jsonc` wholesale, so a key a repo never touched must
still resolve — via the zod default, not the template comment — to behavior
that is both safe and useful. Matching and annotating a reply is safe with zero
review-outcome effect, so it defaults ON; letting a reply (or a model's read of
one) actually remove a finding from the blocking set is a real decision a repo
should make deliberately, so it defaults OFF until a maintainer opts in
[observed] ([schema.ts](../src/config/schema.ts) the comment directly above
`feedback:`, and [load.ts](../src/config/load.ts) `FEEDBACK_CONFIG_DEFAULTS`,
which mirrors the same values for a scope load).

Like `stack` before it ([LLP 0010](./0010-stack-aware-requalification.explainer.md)
"config-and-cli-surface"), `feedback` is root-only: `ScopeReviewConfigSchema`
rejects it with a `z.never({...})` whose message names the reason — "the
comment lifecycle is global" — matching the existing `stack` lock's style
exactly [observed] ([schema.ts](../src/config/schema.ts)
`ScopeReviewConfigSchema`, the `feedback: z.never(...)` entry). One PR has one
comment lifecycle; a scope-level override would be meaningless and a silent
divergence hazard, the identical argument LLP 0010 makes for `stack`. With no
`routing.jsonc` at all, or a scope config that simply omits the block,
`LoadedConfig.feedback` resolves to the same defaults either way — via the root
schema's zod default in the unrouted case, and via `FEEDBACK_CONFIG_DEFAULTS`
in the routed scope-load case — so adoption is exactly as incremental as every
other root-only feature in this engine
[observed] ([load.ts](../src/config/load.ts), the `feedback: parsed.feedback ??
FEEDBACK_CONFIG_DEFAULTS` line).

## `ecr feedback`: The Same Substrate, Read Backwards

Everything above exists to answer one question a maintainer actually asks:
"has this kind of finding been pushed back on before, and how?" `ecr feedback`
answers it without a single model call, because the answer is already sitting in
history: every past reviewer comment embeds the findings it surfaced (`state`),
and `collectFeedback` re-runs the exact same `matchReplies` pass over that
embedded set plus the PR's non-bot comments — no re-review, no re-diff
[observed] ([github.ts](../src/reporters/github.ts) `collectFeedback`;
[feedback.ts](../src/commands/feedback.ts) module header). The one place this
command departs from fingerprint identity on purpose is its "repeat offenders"
grouping: a finding's fingerprint legitimately differs across PRs (different
file, different evidence snippet) even when it is recognizably "the same
issue" to a human, so offenders are grouped by `normalizeTitle` — the identical
normalization the matcher itself uses to compare a quote to a title — not by
fingerprint [observed] ([feedback.ts](../src/commands/feedback.ts)
`repeatOffenders`, keyed on `normalizeTitle(finding.title)`). An offender only
qualifies when it recurred across 2+ PRs AND drew a reply on **every** one of
them, deliberately stricter than "recurred and got at least one reply" — a
title answered once out of three occurrences is noise, not an established
pattern worth surfacing [observed] ([feedback.ts](../src/commands/feedback.ts)
`repeatOffenders`, the `answeredEveryTime` check).

## What Ships Dark, and Why That's the Point

Every piece of this feature composes to the same conservative shape as the
config defaults: annotate is real and on, and no reply has any decision effect
until a maintainer flips `dismiss` off `"never"`. That is deliberate
sequencing, not caution for caution's sake — the same posture
[LLP 0010](./0010-stack-aware-requalification.explainer.md) took for stack
requalification (`enabled: false` by default, "a suppression-adjacent feature
earns trust with field data first"). A repo gets the useful, zero-risk half
(a visible "author replied" annotation, and `ecr feedback`'s retroactive report)
immediately, and the risk-bearing half (a reply actually clearing a finding)
only behind that one explicit knob — `"maintainers"` needs no model at all,
`"adjudicated"` additionally requires `mode: "adjudicate"` so an author's reply
clears only with a source-confirmed verdict — with
`critical`/`secrets`/`security` never reachable by either choice.
