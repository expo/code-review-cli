# Plan: inline PR comments for in-diff findings (rev 2, post adversarial review)

## Goal

Findings anchored to a line in the PR diff land as inline review comments on
that line. The main issue comment keeps every finding but renders an inlined
one SHORT: title + one-line rationale + link to the inline thread. The main
comment stays the single durable state store (embedded state, dismissals,
feedback records, pins, `/dismiss` target). Inline comments are a derived
presentation layer, converged on every run.

## Non-goals (v1)

- No formal `POST /pulls/{n}/reviews` review event: a batched review is atomic
  (one bad anchor 422s the whole post) and cannot be upserted across runs.
  Individual review comments isolate failures and PATCH in place.
- No multi-line comments; single `line` + `side: "RIGHT"` only.
- No GraphQL thread resolution, and no detection of author-resolved/outdated
  threads. Accepted risk: the PR author can collapse inline threads; the main
  comment therefore keeps a one-line rationale per finding (see Short form).
- `ecr feedback` retroactive crawl keeps reading issue comments only. The
  review-comments fetch in `replyComments` is gated on the reporter having an
  ENABLED `inline` option, so the crawl (which passes none) gains no fetches.
- Scopes removed from the routing manifest strand their comments — same
  pre-existing behavior as their main comments.
- Break-glass (`postSkipNote`) leaves inline threads untouched even though it
  overwrites the embedded state. Accepted, documented.

## Config

Root-only key in `ReviewConfigSchema`, locked out of scope configs with
`z.never` like `feedback`:

```jsonc
inline: {
  enabled: false,        // ship dark
  maxComments: 20        // cap per posted comment's reporter (per PR in single/
                         // legacy mode; per scope in per-scope mode — documented)
}
```

Wired into `LoadedConfig`, `load.ts` defaults, all five reporter construction
sites, and `reviewPostingConfigFingerprint` (posting behavior changes with it,
so a saved deferred review must not post under a different inline policy).
Turning it OFF later leaves existing threads up (documented; `clear()` still
sweeps them on mode switches, and a manual cleanup is possible).

## Inline comment identity

Marker, at byte 0 of the body, parsed with an ANCHORED regex and a hex-only
charset:

```
<!-- <tag>:inline:fp=<[a-f0-9]{6,64}> -->
```

- Identity = author (`user.login === ownLogin`) + anchored marker; marker alone
  is never identity (selectOwnComments model). ownLogin unresolvable ⇒ nothing
  is ours AND no creates either (fail closed, no duplicate storms).
- Byte-0 anchoring also narrows the shared `github-actions[bot]` confused-deputy
  risk: an echo-bot that prefixes any content fails the anchor.
- fp is the id the owning main comment renders (plain, or scope-namespaced for
  the aggregate). Substring safety vs `<!-- tag -->` / `<!-- tag:scope -->`
  holds in both directions (closing ` -->` differs), incl. a scope named
  `inline`.

## Inline comment body

Marker line, then the finding rendered in full (severity, title, category,
`id:<fp>` token, rationale, sources, suggestion — every model-written field
through `stripStateMarkers`), then a footer: "Reply here to respond; write
`id:<fp>` in your reply (unquoted) to formally answer it."

**Self-reply backstop (was blocker):** the body carries an unquoted `id:` token,
and today's `OWN_COMMENT_RE` (`:state=|:fingerprints=`) would NOT exclude it if
identity/tag filters ever miss (bot-login fallback, commentTag rename, second
posting identity). Fixes, all three:
- `responses.ts` gains a tag-independent backstop: a body whose UNQUOTED lines
  contain `:inline:fp=` is never treated as a reply (quoted lines excluded so a
  GitHub "Quote reply" of our inline comment — which copies the marker behind
  `> ` — still counts as a genuine reply).
- `replyComments` applies the same unquoted-line rule for the tag-specific
  marker.
- Test: an inline body is never matched as a reply even with `ownLogin: null`
  and a foreign tag; a quote-reply containing the quoted marker IS matched.

## Reporter mechanics

New option `inline?: LoadedConfig["inline"]`.

### Fetch layer

`fetchAllReviewComments()`: paginated GET `repos/{repo}/pulls/{n}/comments`
(fields: id, body, path, line, user.login, html_url, in_reply_to_id,
author_association). Cached in a MODULE-LEVEL map keyed
`prNumber\nrepo\ncwd` (the prAuthorByPr pattern) with the same 30s TTL and
invalidate-on-mutation — routed single-mode runs call `clear()` on a fresh
reporter per scope, and per-instance caching would multiply listings. Note:
this endpoint DOES honor sort/direction (unlike issue comments) — do not copy
that rationale comment; a full scan is still needed.

### Sync

`syncInline(targets, link, opts: { teardown: boolean })` runs inside
`report()` / `reportAggregate()` before rendering; returns `Map<fp, url>`.

Targets = ACTIVE findings only (not dismissed, not reply-cleared, not
requalified) with `line != null` and `diffLines.get(file).has(line)`.

**Cap (sticky, was churn bug):** order candidates by severity rank then fp
(deterministic); fill slots preferring fps that ALREADY have a live inline
comment, then admit new ones. A live thread is never evicted to create a new
one.

**Teardown gating (was blocker):** stubs/deletes run ONLY when
`opts.teardown` is true, which callers set as:
- `report()`: `!review.couldNotComplete`.
- `reportAggregate()`: caller-passed flag — ci.ts passes
  `!scopesFilter && results.every(r => !r.review.couldNotComplete)`. A partial
  `--scopes` run or any failed scope makes the run additive-only (creates +
  patches, no stubs/deletes), because carried/truncated/failed state cannot
  prove a finding is gone. (`scopedFingerprint` is opaque hex — a per-scope
  stale set cannot be derived from fps, so the gate is all-or-nothing.)
- `applyDismissal`: never computes a stale set. Additive-only: stub threads of
  the explicitly dismissed fps; on `/undismiss`, re-patch the full body if the
  finding is present in state (skip if truncated away).
- Prereq fix: both failure literals (`ci.ts` legacy catch and
  `failureReview()`) gain `couldNotComplete: true` — today they post
  empty-findings reviews WITHOUT the flag and would tear everything down. Side
  effects checked: the decision label becomes the accurate "No review — every
  pass failed", and caching is unaffected (failures already never carry
  inputHash).

**Stub text (was blocker):** neutral — "This finding is no longer tracked
inline — see the main review comment for current status." Never
"resolved/dismissed": a capped-out or drifted finding is still active.

**Mutations** (sequential, never parallel):
- create: POST with body/commit_id=headSha/path/line/side. Creates require
  headSha AND a live-head check: one `gh pr view --json headRefOid` per sync
  (only when creates exist); mismatch ⇒ skip creates, log (a mid-review push
  means our diff no longer matches the head; a stale commit_id can silently
  anchor to wrong code, and a force-push 422s every create).
- patch: only when the normalized body differs (`\r\n` → `\n`) — no PATCH-per-
  finding-per-run forever.
- stale (teardown only): thread has replies ⇒ PATCH to the neutral stub
  (marker kept, so a returning finding revives the thread); no replies ⇒
  DELETE. Reply detection: any listed comment with `in_reply_to_id` == our id
  (same snapshot; the reply-between-list-and-delete race is accepted, noted in
  tests).
- duplicates (crash window): keep newest per fp, older are stale.
- 422 on create ⇒ log once + skip that finding (renders full-form). 403/429
  (secondary rate limit) ⇒ log + abort ALL remaining mutations this run.
- Audit (was silent): stderr one-liner + step-summary line:
  `inline sync: N created, N patched, N stubbed, N deleted, N failed`.

Every mutation individually try/caught; the inline layer never blocks the main
comment. Listing failure ⇒ empty map, no mutations.

### clear()

Extends to inline comments under this reporter's tag, gated on marker+author
only (NOT on `enabled`, so mode switches clean up after a disable): replied
threads are STUBBED, bare ones deleted — never delete a thread humans wrote in
(ci.ts calls clear() on mode switches and scope reconciliation). This also
covers the fp-namespace flip on per-scope↔single switches, symmetric with how
main comments are cleared today.

### Main-comment short form

- `LinkContext.inlineUrls?: Map<string, string>`. NEVER mutate the shared
  routed-flow `link` object — render with a copy `{ ...link, inlineUrls }`.
- `renderFindingLines` with an inline URL: `- **title** —
  [file:line](thread-url) _(category)_ · id:… · 💬 [inline](url)` + reply
  annotation + ONE-LINE truncated rationale (~160 chars, word boundary) — the
  audit trail survives the author collapsing/resolving inline threads.
  Sources/suggestion/full rationale live inline only. Missing URL ⇒ full form
  (tested).
- Embedded state unchanged.

### Inline replies → feedback

- `replyComments()` maps review comments too — ONLY when
  `options.inline?.enabled` (keeps `ecr feedback` crawl and non-inline repos at
  zero extra fetches). Excludes own login; excludes bodies whose unquoted lines
  carry our markers.
- **Id namespace (was collision risk):** review-comment-sourced ReplyComments
  get `id = -reviewCommentId`. Negative ids flow into FeedbackRecord.commentId
  (schema unchanged — number stays a number) and are consistent across runs, so
  mergeFeedback's `commentId` equality and buildAdjudicationItems' body lookup
  stay collision-free vs the positive issue-comment space.
- `applyPins` gains a cross-stream guard: a pin is lifted only by a maintainer
  record whose commentId is newer AND in the SAME stream (same sign). A
  different-stream comparison is undecidable ordering ⇒ keep the pin (fail
  closed).
- `ReplyComment.threadFp?: string`: set when the reply's `in_reply_to_id`
  resolves to OUR (author+anchored-marker) top-level inline comment's fp.
  `matchReplies` treats a known threadFp as a match in EVERY `match` mode
  (structural signal, not text matching; documented + tested). `citedId` is
  unchanged: clearing still requires the replier's own unquoted `id:` token.
- Newest-wins across streams: negative ids lose to positive ones by raw
  comparison; acceptable because only the newest record per fp matters and a
  same-fp cross-stream tie is rare; the applyPins guard removes the dangerous
  consequence.

## Files touched

- `src/config/schema.ts`, `src/config/load.ts` — `inline` key + lock + defaults.
- `src/core/deferred-review.ts` — fingerprint includes `inline`.
- `src/reporters/github.ts` — review-comments fetch (shared cache), syncInline
  + pure exported planner, replyComments extension, clear(), applyDismissal
  additive sync.
- `src/core/render.ts` — inline marker helpers (anchored parse), inline body
  renderer, `LinkContext.inlineUrls`, short form + rationale truncation.
- `src/core/responses.ts` — threadFp, unquoted-marker backstop.
- `src/core/schema.ts` — applyPins same-stream guard.
- `src/commands/ci.ts` — wire config, `couldNotComplete: true` on both failure
  literals, aggregate teardown flag. `review.ts`, `post-review.ts`,
  `dismiss.ts` — wire config.
- Tests: planner (create/patch/stub/delete, sticky cap, dedupe, additive mode),
  marker anchor/forgery, short form + missing-URL fallback, backstop vs
  quote-reply, threadFp in all match modes, applyPins stream guard,
  couldNotComplete literals.
- `templates/config.jsonc`, `README.md`.

## Rollout

Ship dark. Note in README: first enable on a large PR fires one notification
per created inline comment (cap bounds it). Enable on this repo first, then
expo/expo after one observed cycle.
