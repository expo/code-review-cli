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

Matching is not consent, though: what a match records and what may CLEAR a finding are
two different questions, and the section "A Quote Annotates, an Id Clears" below is why.

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
[observed] ([schema.ts](../src/core/schema.ts) `FindingSchema.agent`). "Never by the
model" is enforced at the parse boundary, not by convention: `agent` is a RECOGNIZED key
of `FindingSchema`, so zod's strip could not drop it and a reviewer pass — or the
coordinator, which reads the untrusted diff and PR body — could emit `"agent": "…"` and
have it survive validation. The model-facing `ModelFindingSchema` omits the field, and
both model outputs parse through it, so the engine's own fingerprint lookup is the only
writer that exists [observed] ([schema.ts](../src/core/schema.ts) `ModelFindingSchema`,
used by `ReviewerOutputSchema` and `CoordinatorOutputSchema`). It is
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

That authoritative set is built by reading fresh records ONLY from `results` —
this run's freshly-reviewed scopes — never from `finalResults`, the full set the
aggregate comment renders (fresh scopes plus whatever `mergePartialAggregate`
carried over from a `--scopes` partial run). A carried-over scope's entry in
`finalResults` still embeds whatever `review.feedback` array a PAST full run
wrote for it; reading records back out of that array would resurrect a stale
per-scope copy over a newer top-level record — most concretely, a human
`/undismiss` that already overrode the top-level record (pinning the finding, see
"The Pin Belongs to the Finding") on a fingerprint the carried scope's own
embedded copy still remembers as applied. `mergeAggregateFeedback` therefore treats
`finalResults` as read-only for resolving each kept record's CURRENT finding
(the fingerprint-to-finding lookup for recomputing `applied`), never as a source
of feedback records itself [observed] ([ci.ts](../src/commands/ci.ts)
`mergeAggregateFeedback`, the `results.flatMap(scopeFeedbackRecords)` loop).
This is also why the embedded state never lets a per-scope copy exist to be read
back in the first place: `renderAggregateMarkdown` strips `feedback` off each
scope's embedded `review` before writing state, since the top-level `feedback`
array is the single source of truth and a per-scope duplicate is exactly the
stale copy this paragraph guards against [observed] ([render.ts](../src/core/render.ts),
the `stateScopes` map's `_feedback` destructure).

## A Quote Annotates, an Id Clears

Matching a reply by its quoted title is right for ANNOTATING and wrong for CLEARING,
because the quoted text is not written by the person who posted the comment. GitHub's
"Quote reply" copies the whole target comment and prefixes every line with `> `, and
the PR author controls that text. So: the bot posts the review, which makes every
finding title (and every `id:` token) public; the author writes one of those titles on
its own line inside an innocent question; a maintainer answers with one click of "Quote
reply"; the maintainer's comment now holds `> <finding title>`, `extractQuotedLines`
returns it, `normalizeTitle` makes it equal to the title, and the match is recorded with
`maintainer: true` — because `replyComments` reads the maintainer flag off
`author_association`, which is correct and unspoofable, and says nothing about the words
being the maintainer's own. Under `dismiss: "maintainers"` that used to be enough to
move the finding into the collapsed Dismissed fold. The same path fired BY ACCIDENT
whenever a maintainer quote-replied to an author comment that had pasted a finding
title, and the mirror case exists on the author path too (the author quote-replying to
someone else's comment).

Hence the split: **a quote-only match may annotate a finding; only a reply that cites
the finding's `id:<fp>` token may clear one.** `matchReplies` records which of the two
happened in `citedId` on the record, and `feedbackApplied` returns `false` before either
clear path when it is not `true` [observed] ([responses.ts](../src/core/responses.ts)
`matchReplies`, `citedId: cited.has(fp)`; [adjudicate.ts](../src/core/adjudicate.ts)
`feedbackApplied`, the `record.citedId !== true` guard). Three properties make that
gate mean something:

- **The id counts only outside a blockquote.** The id is as public as the title, so a
  planted `> id:abc123` would defeat the gate exactly like a planted title.
  `extractCitedFindingIds` drops every `>`-prefixed line before scanning, so only an id
  in the replier's OWN words counts — and one click of "Quote reply" produces nothing
  but quoted lines [observed] ([responses.ts](../src/core/responses.ts)
  `extractCitedFindingIds`).
- **It is derived, never stored-and-trusted.** `citedId` is re-derived from the live
  comment on every run, the same discipline as `maintainer`/`author`; absent reads as
  "did not cite", so a record written by an older version (or carried through a failed
  seam) fails CLOSED to annotate-only until its reply is matched again
  [observed] ([schema.ts](../src/core/schema.ts) `FeedbackRecordSchema.citedId`,
  optional).
- **It is orthogonal to the `match` config.** `match` (`"quote"`/`"id"`/`"both"`)
  selects how a reply is MATCHED and is unchanged; `citedId` is computed whatever it
  says, so a repo on `match: "quote"` still annotates every quote and still clears on a
  cited id [observed] ([responses.ts](../src/core/responses.ts) `matchReplies`, `cited`
  built outside the `opts.match` branches).

The cap follows the same logic: a quote-only reply cannot clear whatever a verdict says,
so `adjudicateFeedback` no longer spends a model call on it — judging it would consume
`maxAdjudications` on an outcome-free rebuttal and could starve one that does cite the
finding [observed] ([adjudicate.ts](../src/core/adjudicate.ts) `adjudicateFeedback`, the
`toJudge` filter). The `/undismiss` pin is untouched by all this: a maintainer's newer
reply still LIFTS a pin without citing anything, because lifting is not clearing — after
the lift the record still has to cite the id to remove the finding, so the worst a
quote-reply can do is return the finding to the ordinary rules.

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
`/dismiss` in prose form. A maintainer's reply that CITES the finding's id clears it
with no model involved at all (`record.maintainer` plus `record.citedId`, see "A Quote
Annotates, an Id Clears"); among everyone else, only the PR
AUTHOR's cited reply can clear one, and only under `dismiss: "adjudicated"` AND a
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

Re-deriving it costs a `gh pr view`, and `mode: "annotate"` is the shipped
default, so that call would otherwise land on EVERY report of every adopting
repo — multiplied per scope in routed CI, which builds a fresh reporter per
scope plus one for the seam. Two things bound it, and neither weakens the fail-
closed rule. The flag gates exactly one branch, so it is resolved only when that
branch is reachable: `feedbackNeedsPrAuthor` returns true for
`dismiss: "adjudicated"` and nothing else, and a skipped lookup reads the same
as a failed one — `author: false`, clears nothing
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `feedbackNeedsPrAuthor`;
[github.ts](../src/reporters/github.ts) `replyComments`). And when it does run,
the result is memoized per PR across reporter INSTANCES, not per instance: the
author's login is a property of the PR, so N scopes share one call. The cache
holds the in-flight promise (concurrent scopes join it rather than racing) and
is keyed by checkout + repo + PR number, so a lookup can never leak across the
many PRs the `ecr feedback` crawl walks in one process
[observed] ([github.ts](../src/reporters/github.ts) `prAuthorByPr`,
`prAuthorCacheKey`, `sharedPrAuthor`).

Only a SUCCESSFUL lookup is cached, though. A failed `gh pr view` resolves to
null — the fail-closed answer for that attempt — and caching that null would turn
one rate-limited call into a process-wide outcome: the first scope's blip would
mark every later scope's replies `author: false` and keep the adjudicated clear
path from firing for the rest of the run, on a PR where the very next attempt
would have succeeded. Sharing the cache across instances is what made that a
single point of failure, so `sharedPrAuthor` deletes its entry when the promise
settles to null (or rejects), leaving neither a poisoned result nor a dangling
in-flight entry, while the entry is still what concurrent scopes join
[observed] ([github.ts](../src/reporters/github.ts) `sharedPrAuthor`, the
`forget` helper).

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
any verdict — instead of discarding them, and the pin set rides the state
untouched beside them. Returning an empty list here instead would silently erase
every recorded reply from the comment's embedded state the moment a repo flips
the switch, with no way back; `"off"` must mean "stop matching new replies," not
"forget the ones already recorded" [observed]
([github.ts](../src/reporters/github.ts) `computeFeedback`, the
`!config || config.mode === "off"` branch returning `reapply(previous)`).

`applied` being a function of the current config and not a stored fact has to
hold on EVERY path that rewrites the comment, including the one that runs no
review: `/dismiss` and `/undismiss` re-render the whole comment from its embedded
state, so a record they do not touch used to flow through with whatever `applied`
the run that stored it computed. A repo that had since tightened `dismiss` back
to `"never"`, or widened `protectedCategories`, would then keep an unrelated
finding hidden until the next full review — a maintainer's action on finding A
freezing the policy on finding B. `applyDismissalToState` therefore maps every
record through the same `feedbackApplied`, resolving each record's finding by the
id the comment renders it under (scope-namespaced on an aggregate comment); a
record whose finding is gone keeps its stored flag, exactly as `computeFeedback`
does [observed] ([github.ts](../src/reporters/github.ts)
`applyDismissalToState`, `stateFindingsById`). `ecr dismiss` passes the loaded
`feedback` block to the reporter for that reason
[observed] ([dismiss.ts](../src/commands/dismiss.ts)).

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
`renderAggregateMarkdown`, `feedbackById` keyed via `idOf`). That fold opens
whenever the scope has an active finding, a requalified one, OR a reply that
suppressed one: a scope whose ONLY findings were cleared by replies (`shown`
and `requalifiedAll` both empty) still opens with the audit note above the
fold, never collapsed away as if the scope were silently clean
[observed] ([render.ts](../src/core/render.ts) `renderAggregateMarkdown`, the
`open` line's `replies.length > 0` disjunct).

Feedback records — and the `/undismiss` pin set beside them — also ride the
embedded comment state exactly like dismissals: they are never trimmed away by
the aggregate's size-based truncation loop, even when that loop is shrinking how
many findings are shown, because losing one would silently lose a verdict a prior
run already decided, or a restore no later run could recover
[observed] ([render.ts](../src/core/render.ts) `renderAggregateMarkdown`, the
comment above the state marker: "Feedback records and `/undismiss` pins ride the
state whole, never trimmed by the cap loop"). And the reporter's merge step
(`mergeFeedback`) only ever carries a decided `verdict`/`reason`/`applied`
forward when the newest reply on that finding is the SAME comment it was
decided about — a newer reply resets the decision, because a new reply answers
different words and deserves its own judgment
[observed] ([github.ts](../src/reporters/github.ts) `mergeFeedback`, the
`prior.commentId === record.commentId` gate).

That same-comment gate is necessary but not sufficient. A verdict is a claim
about SOURCE, not only about words: `fingerprintFinding` deliberately excludes
the line number, so a finding keeps its identity while the code that justified
the rebuttal is edited away elsewhere in the file. `dropStaleVerdict` is the one
predicate that says so: a decided `verdict`/`reason`/`applied` survives only
while the record's `sourceSha` — the reviewed head OID stamped on it when the
adjudicator answered — equals the head this run reviews
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `dropStaleVerdict`;
`adjudicateFeedback`, the `sourceSha` stamp). Unknown source counts as
different, never as trusted: a run with no head SHA (the `ecr feedback` crawl,
which reviews nothing, or `local-git`, which resolves no `headOid`) and a record
written before the field existed both drop the verdict, so a missing SHA can
never pin a decision forever [observed] ([schema.ts](../src/core/schema.ts)
`FeedbackRecordSchema.sourceSha`, optional). The dropped record flows back
through `adjudicateFeedback`'s `toJudge` filter and the reply is judged again
against the new source; its stale `applied: true` drops with it, so no render
hides the finding in between.

That predicate is deliberately ONE exported function rather than a rule each
merge path restates. There are two such paths — `mergeFeedback` in the reporter,
and `mergeAggregateFeedback` in `ci.ts` for the `comment:'single'` aggregate —
and they did drift: the aggregate path kept every prior record whose fingerprint
no fresh scope claimed and only recomputed `applied`, which `feedbackApplied`
derives without ever looking at `sourceSha`. A scope whose seam threw on run 2
therefore carried run 1's `"accepted"` verdict onto a head that verdict never
judged, and because `reportAggregate` skips `computeFeedback` whenever it is
handed explicit records, nothing downstream re-checked it. Both paths now call
`dropStaleVerdict` on every record they take from prior state — fresh records
are exempt, having just been stamped with this run's own source
[observed] ([ci.ts](../src/commands/ci.ts) `mergeAggregateFeedback`, the
`dropStaleVerdict` in the `prior` filter; [github.ts](../src/reporters/github.ts)
`mergeFeedback`).

Two things deliberately survive a head change. A verdict-less record does,
because a maintainer clears with no model call and no verdict, so it has no
source-dependent decision to go stale
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `dropStaleVerdict`, the
`record.verdict === undefined` short-circuit). And a maintainer's `/undismiss`
pin does — it is not a claim about source at all, which the next section is
about. The cost is real and bounded: a push that touches nothing relevant
re-spends adjudication budget re-judging the same words, capped by
`maxAdjudications`. Paying that beats hiding a finding against source the
rebuttal no longer fits.

## The Pin Belongs to the Finding

Suppression by reply must be exactly as reversible as suppression by
`/dismiss`: a maintainer running `/undismiss <id>` on a finding a REPLY cleared
(not only a manual dismissal) restores it to the active list, not just to the
Dismissed fold. So `/undismiss` records a **pin** on that finding, and
`feedbackApplied` checks the pin before any other floor — a later re-review,
recomputing `applied` from that same still-present reply, must not silently
re-clear what the human just restored
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `feedbackApplied`, the
`record.unclearedByHuman` guard; [github.ts](../src/reporters/github.ts)
`applyDismissalToState`, the `removeSet` branch).

**The pin belongs to the FINDING, not to one reply — so it cannot live on a
reply record.** It is stored as its own field of the embedded comment state, a
`pins` set of `{fp, commentId}`, and every render writes that set forward whole:
not indexed by the records this run matched, not filtered by the findings this
run emitted, and never trimmed by the aggregate's size cap loop
[observed] ([render.ts](../src/core/render.ts) `reviewState`, `ReviewState.pins`;
[schema.ts](../src/core/schema.ts) `FeedbackPinSchema`). `applyPins` stamps the
set back onto the matched records (`unclearedByHuman: true`, `applied: false`)
so `feedbackApplied` stays a pure record-local decision, and strips the flag from
any record the set does not pin — the set decides, the flag is only its shadow
[observed] ([schema.ts](../src/core/schema.ts) `applyPins`; call sites in
[github.ts](../src/reporters/github.ts) `computeFeedback`,
`buildAdjudicationItems`, `report`/`reportAggregate` and in
[ci.ts](../src/commands/ci.ts) `mergeAggregateFeedback`).

Two rounds of this design got the lifetime wrong, in the same direction both
times: binding the pin to something the untrusted PR author controls. The first
bound it to one `commentId`, reasoning that "a newer reply is a fresh decision
that shouldn't be gagged" — but `matchReplies` keeps only the NEWEST comment per
finding, so the author had only to post one more comment quoting the same title:
the fresh record carried a different id, the pin vanished, the reply was judged
again, and an `"accepted"` verdict removed the finding a maintainer had just
restored. The second kept the pin on the record while carrying it across a newer
reply — which closed that path but not the shorter one, because a record exists
only while some reply still matches the finding. `mergeFeedback` maps over the
FRESH records, and the render stores only what it returns, so one run with no
matching reply wrote the pin out of existence: the author edits (or deletes) the
comment that quoted the finding, pushes, then restores the quote and pushes
again, and the reply is judged afresh with no pin left to stop it. The aggregate
path lost it the same way, for every fingerprint a fresh scope claimed. The
non-attack case is identical and just as bad: a re-review that simply does not
emit that finding this run would drop a maintainer's restore.

Hence the invariant: **a pin is created and lifted only by a maintainer action,
and nothing else can touch it.** A `/dismiss` on that finding lifts it —
`applyDismissalToState` removes the fp from the set, the same trusted hand
deciding the opposite way. A maintainer's own newer reply lifts it — the same
trusted hand, and a lift is not a clear: the lifting reply still has to cite the
finding's id before it removes anything (see "A Quote Annotates, an Id Clears"), so a
lift only returns the finding to the ordinary rules. "Newer"
is decided against the comment id stored with the pin, so a maintainer comment
that predates the restore (one the author could resurrect by deleting their own
later reply) never releases it
[observed] ([schema.ts](../src/core/schema.ts) `applyPins`, the
`record.commentId > (pin.commentId ?? 0)` gate). Everything else — a newer reply
from the PR author, an edited, deleted or unmatched reply, a moved head, a run
that re-emits nothing — leaves the pin exactly where it is. A human's override is
not a claim about one comment's words, nor about one revision; it is a decision
about that finding. The rebuttal still gets its hearing — from a maintainer, who
can `/dismiss` or reply themselves.

A pinned finding is also excluded from `adjudicateFeedback`'s model pass — there
is nothing to gain by re-judging a reply whose verdict, even if `"accepted"`, a
human has already overridden
[observed] ([adjudicate.ts](../src/core/adjudicate.ts) `adjudicateFeedback`,
the `toJudge` filter).

The embedded state is a compatibility surface, so moving the pin needed a
migration, not a cutover: a comment written before `pins` existed carries its
pins on the records themselves, and reading it as "no pins" would silently
release every restore already made. `collectPins` unions the state's set with any
record-level `unclearedByHuman` flag, and `parseReviewState` runs it on every
read, so a v3 comment upgrades on its next render
[observed] ([render.ts](../src/core/render.ts) `parseReviewState`;
[schema.ts](../src/core/schema.ts) `collectPins`). The flag is still written onto
the records too — as a derived mirror, never as the storage — so a comment this
version writes also reads correctly under an older one.

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

Because the crawl is retroactive and stateless, two failure modes could
otherwise print identical output to "no pushback ever happened": scanning the
wrong repo, and a `commentTag`/`--as` mismatch that makes every past comment
invisible to `readState`/`replyComments`. `--repo` lets a crawl target a repo
other than the local checkout, but `feedbackCommand` always loads
`.expo-code-review/config.jsonc` from the LOCAL checkout — it never fetches or
trusts a remote repo's config, since a repo's own config is untrusted input
from the reviewed repo's perspective (see [LLP 0001](./0001-trust-model.principles.md)).
When `--repo` differs from the local checkout's own repo,
`repoConfigMismatchWarning` prints a warning naming both repos so a
zero-findings crawl is not mistaken for zero pushback [observed]
([feedback.ts](../src/commands/feedback.ts) `repoConfigMismatchWarning`,
`feedbackCommand`). Separately, when every scanned PR came back with no bot
comment at all, `allNullCrawlWarning` surfaces that as an explicit line in the
totals section instead of leaving it as an easy-to-miss "0 with a bot comment"
[observed] ([feedback.ts](../src/commands/feedback.ts) `allNullCrawlWarning`,
`formatFeedbackReport`). Both are warnings only: neither changes which config
loads or which PRs get scanned, matching this feature's fail-open-but-visible
posture throughout.

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
`critical`/`secrets`/`security` never reachable by either choice, and every clear
requiring the replier to cite the finding's id in their own words.
