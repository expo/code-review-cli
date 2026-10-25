// @ref LLP 0005#comment-rendering — pure Markdown builder; the comment body is the durable state store
// @ref LLP 0013#research-provenance-and-citations [implements] — grounded finding sources render visibly and persist in durable state
import { createHash } from "node:crypto";

import {
  collectPins,
  FeedbackPinSchema,
  FeedbackRecordSchema,
  fingerprintFinding,
  knownSeverity,
  MENTION_TARGET_RE,
  MentionStateSchema,
  scopedFingerprint,
  SEVERITIES,
  SEVERITY_RANK,
} from "./schema.js";
import type {
  AgentMention,
  AgentSummary,
  CoordinatorOutput,
  Decision,
  DismissalRecord,
  FeedbackPin,
  FeedbackRecord,
  Finding,
  MentionState,
  Severity,
} from "./schema.js";

/**
 * Enough PR context to turn a finding's `file:line` into a link to that line in
 * the PR's "Files changed" diff. Omitted for terminal output (plain text).
 *
 * `diffLines` maps each changed file to the set of right-side (new-version) line
 * numbers present in the PR's diff. A `#diff-…R<line>` anchor only exists for lines
 * actually shown in the diff, so we link ONLY when the finding's file+line is in
 * here — otherwise the finding points at unchanged code (a caller, a helper the PR
 * merely uses) and a diff link would be dead, so we render plain text instead.
 */
export interface LinkContext {
  repo: string; // owner/repo
  prNumber: number;
  diffLines?: Map<string, Set<number>>;
  /**
   * Permalinks to this run's live inline finding comments, keyed by the SAME id the
   * comment renders (plain fingerprint, or scope-namespaced for an aggregate). A
   * finding with an entry is left out of the finding list and only counted, because
   * its full text lives in the inline thread; a finding without one renders in full.
   * Callers must pass a per-render COPY of a shared
   * LinkContext (`{ ...link, inlineUrls }`), never mutate the shared object: the
   * routed ci flow shares one context across every scope reporter.
   */
  inlineUrls?: Map<string, string>;
  /**
   * The PR base commit SHA (the branch the PR targets, e.g. `main`). When a finding
   * points at code NOT in the diff — a caller or helper the PR merely references,
   * which is by definition unchanged and therefore identical on the base — we link
   * to the source blob at this commit (`/blob/<sha>/<path>#L<line>`) instead of a
   * diff anchor: still a working, line-accurate link, just to the file on the base
   * branch rather than the diff. A commit SHA (not a branch name) so it's a stable
   * permalink that won't drift as the base advances.
   */
  baseSha?: string;
}

/**
 * Build the file → right-side-line-numbers index from changed files' patch text,
 * by walking each unified-diff hunk (`@@ -a,b +c,d @@`) and collecting the new-tree
 * line number of every added (`+`) and context (` `) line. Deleted (`-`) lines have
 * no right-side line and are skipped.
 */
export function buildDiffLineIndex(
  files: Array<{ path: string; patch: string }>,
): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  for (const file of files) {
    const lines = new Set<number>();
    let right = 0;
    let inHunk = false;
    for (const raw of file.patch.split("\n")) {
      const hunk = hunkRe.exec(raw);
      if (hunk) {
        right = parseInt(hunk[1]!, 10);
        inHunk = true;
        continue;
      }
      if (!inHunk || raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("\\")) {
        continue;
      }
      const marker = raw[0];
      if (marker === "+" || marker === " ") {
        lines.add(right);
        right++;
      }
      // '-' is left-side only (no new-tree line); anything else is ignored.
    }
    if (lines.size > 0) {
      index.set(file.path, lines);
    }
  }
  return index;
}

// User-facing labels only — the wire/schema enum stays `approve` etc. The review
// is advisory and never approves anything, so the labels must not read as an
// approval either: a clean result is "ready for a human", not "approved".
const DECISION_LABEL: Record<Decision, string> = {
  approve: "Ready for human review",
  approve_with_comments: "Ready for human review (with comments)",
  request_changes: "Request changes",
};

export function decisionLabel(decision: Decision): string {
  return DECISION_LABEL[decision];
}

/** Rubric exit code: 0 for approve / approve-with-comments, 1 for request-changes. */
export function decisionExitCode(decision: Decision): number {
  return decision === "request_changes" ? 1 : 0;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[knownSeverity(a.severity)] - SEVERITY_RANK[knownSeverity(b.severity)],
  );
}

export function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const groups: Record<Severity, Finding[]> = {
    critical: [],
    warning: [],
    design: [],
    suggestion: [],
    nit: [],
  };
  for (const finding of findings) {
    groups[knownSeverity(finding.severity)].push(finding);
  }
  return groups;
}

/** HTML marker identifying the reviewer's single PR comment (used for upsert). */
export function commentMarker(tag: string): string {
  return `<!-- ${tag} -->`;
}

/**
 * Per-finding identity marker of an inline (PR review) comment, always rendered at
 * byte 0 of the body. Substring-safe against `commentMarker(tag)` and any derived
 * scope tag (`<tag>:<scope>`) in both directions — the closing ` -->` differs —
 * including a scope literally named `inline`.
 */
export function inlineCommentMarker(tag: string, fp: string): string {
  return `<!-- ${tag}:inline:fp=${fp} -->`;
}

/**
 * The fingerprint an inline comment of OURS carries, or null. Anchored at byte 0
 * and constrained to the fingerprint alphabet, so a marker echoed later in a body
 * (untrusted prose, a quote-reply) can never parse as identity — mechanical
 * safety, not just the incidental "our renderer emits it first". Identity itself
 * is author + this marker (see the reporter); the parse alone proves nothing.
 */
export function parseInlineMarkerFp(body: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^<!-- ${escapedTag}:inline:fp=([a-f0-9]{6,64}) -->`));
  return match ? match[1]! : null;
}

// @ref LLP 0011#forged-state-markers [implements] — the first-match parsers make an earlier forged marker win, so untrusted prose never keeps a raw `<!--`
/**
 * Neutralize anything that could impersonate this reviewer's embedded state
 * comment. `parseReviewState` and `parseEmbeddedFingerprints` match with a
 * non-global RegExp, so they take the FIRST marker in the body while the genuine
 * one is appended LAST: a forged `<!-- tag:state=… -->` rendered earlier — inside
 * a model-written rationale, a path, a dismissal reason — would win over the real
 * state and let PR content dictate the dismissal list. None of that prose ever
 * legitimately needs an HTML comment, so every `<!--` in it is escaped.
 */
export function stripStateMarkers(text: string): string {
  return text.replace(/<!--/g, "&lt;!--");
}

/** GitHub logins are `[A-Za-z0-9-]`, 39 chars max — anything else is forged. */
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

/** A reply link must be a github.com URL, so a record can't inject an arbitrary
 * target into the body. */
const REPLY_URL_RE = /^https:\/\/github\.com\/[\w.\-/#]+$/;

// @ref LLP 0011#never-echo-reply-text [constrained-by] — only the login and the link are rendered, both validated; a login that isn't GitHub-shaped names no one
/**
 * `@login`, or `an author` when the login isn't GitHub-shaped. The reply's own
 * text is never rendered, so this credit line is the whole of what a reply
 * contributes to the body.
 */
function replyAuthor(record: FeedbackRecord): string {
  return LOGIN_RE.test(record.by) ? `@${record.by}` : "an author";
}

/** Link `text` to the reply comment, or leave it plain when the URL doesn't
 * validate. */
function replyLink(text: string, record: FeedbackRecord): string {
  return record.url && REPLY_URL_RE.test(record.url) ? `[${text}](${record.url})` : text;
}

function locationText(finding: Finding): string {
  // A git path may legally hold anything, including a forged state marker.
  const file = stripStateMarkers(finding.file);
  return finding.line != null ? `${file}:${finding.line}` : file;
}

// @ref LLP 0005#comment-rendering [implements] — diff anchor only if the line is in the diff; else base-SHA blob (f9fecd5)
/**
 * Render a finding's location as inline code, linked to the code it points at:
 *  - in the diff (file+line shown in a hunk) → the PR's "Files changed" tab at that
 *    line (`#diff-<sha256(path)>R<n>`), so the reader lands in the review diff;
 *  - not in the diff (unchanged code the PR references, e.g. a caller/helper) → the
 *    source blob on the PR base at that line (`/blob/<baseSha>/<path>#L<n>`);
 *  - if neither is possible (no link context / no base SHA) → plain inline code.
 * Never emits a dead diff anchor for a line that isn't in the diff.
 */
function location(finding: Finding, link?: LinkContext): string {
  const text = locationText(finding);
  if (!link) {
    return `\`${text}\``;
  }
  const fileLines = link.diffLines?.get(finding.file);
  // In the diff when the file is present and (if the finding names a line) that line
  // is one of the diff's right-side lines. A file-level finding (no line) counts as
  // in-diff as long as the file appears in the diff.
  const inDiff = fileLines != null && (finding.line == null || fileLines.has(finding.line));
  if (inDiff) {
    const fileHash = createHash("sha256").update(finding.file).digest("hex");
    const anchor = finding.line != null ? `diff-${fileHash}R${finding.line}` : `diff-${fileHash}`;
    const url = `https://github.com/${link.repo}/pull/${link.prNumber}/files#${anchor}`;
    return `[\`${text}\`](${url})`;
  }
  if (link.baseSha) {
    const lineAnchor = finding.line != null ? `#L${finding.line}` : "";
    const url = `https://github.com/${link.repo}/blob/${link.baseSha}/${stripStateMarkers(finding.file)}${lineAnchor}`;
    return `[\`${text}\`](${url})`;
  }
  return `\`${text}\``;
}

/** GitHub's comment body limit is ~65k chars; keep a margin. */
const MAX_COMMENT_CHARS = 60_000;

/**
 * GitHub comment body. The marker + embedded state enable in-place updates and
 * per-PR dismissals. Findings whose fingerprint appears in `dismissed` render in a
 * collapsed "Dismissed" section instead of the main list. An oversized body leaves
 * out the agent summaries, from the visible rows and the embedded state, with a note.
 * `mentioned` is the mention state of the comment this body replaces.
 */
export function renderMarkdown(
  review: CoordinatorOutput,
  tag: string,
  dismissed: DismissalRecord[] = [],
  link?: LinkContext,
  feedback: FeedbackRecord[] = [],
  pins: FeedbackPin[] = [],
  inputHash?: string,
  mentioned?: MentionState,
): string {
  // @ref LLP 0005#truncation-and-aggregate-state [implements] — over the size limit, the single comment leaves out the agent summaries, as the aggregate does first
  const body = renderReviewBody(review, tag, dismissed, link, feedback, pins, inputHash, mentioned);
  if (body.length <= MAX_COMMENT_CHARS || !review.agentSummaries?.length) {
    return body;
  }
  // Escaping and the base64 state copy make the summaries several times their byte
  // budget, and a body over GitHub's limit fails to post: the review would be lost to
  // the failure notice. The summaries never affect the decision, so they go.
  const { agentSummaries: _leftOut, ...withoutSummaries } = review;
  return renderReviewBody(
    withoutSummaries,
    tag,
    dismissed,
    link,
    feedback,
    pins,
    inputHash,
    mentioned,
    true,
  );
}

function renderReviewBody(
  review: CoordinatorOutput,
  tag: string,
  dismissed: DismissalRecord[],
  link: LinkContext | undefined,
  feedback: FeedbackRecord[],
  pins: FeedbackPin[],
  inputHash: string | undefined,
  mentioned: MentionState | undefined,
  summariesLeftOut = false,
): string {
  const dismissedByFp = new Map(dismissed.map((record) => [record.fp, record]));
  const withFp = review.findings.map((finding) => ({ finding, fp: fingerprintFinding(finding) }));
  const feedbackByFp = matchedFeedback(feedback, new Set(withFp.map((entry) => entry.fp)));
  // An applied reply cleared the finding, so it leaves the active list exactly
  // like a dismissal — with its own audit line saying a reply is what did it.
  const isDropped = ({ fp }: { fp: string }): boolean =>
    dismissedByFp.has(fp) || feedbackByFp.get(fp)?.applied === true;
  const notDismissed = withFp.filter((entry) => !isDropped(entry));
  const dropped = withFp.filter((entry) => isDropped(entry));
  // A requalified finding is addressed by a stacked PR: shown in its own collapsed
  // section and counted, but never in the main (blocking) severity list.
  const kept = notDismissed.filter(({ finding }) => !finding.requalifiedBy);
  const requalified = notDismissed.filter(({ finding }) => finding.requalifiedBy);

  const lines: string[] = [commentMarker(tag), "## 🤖 AI code review", ""];
  lines.push(
    `**Decision:** ${review.couldNotComplete ? "No review — every pass failed" : decisionLabel(review.decision)}`,
    "",
    modelText(review.summary),
    "",
  );
  const mentionState = nextMentionState(mentionHandles(review.mentions), mentioned);
  lines.push(...mentionLines(review.mentions, mentionState.live));
  lines.push(
    ...(summariesLeftOut
      ? [AGENT_SUMMARIES_LEFT_OUT, ""]
      : agentSummariesSection(review.agentSummaries)),
  );

  if (review.incomplete.length > 0) {
    lines.push(
      "> ⏱️ **Coverage note:** coverage is partial — some review passes did not",
      "> finish (timed out or failed), so issues may exist in areas not fully reviewed:",
      ...review.incomplete.map((note) => `> - ${stripStateMarkers(note)}`),
      "",
    );
  }

  lines.push(...setupNote(review.setupNotes));
  lines.push(...requalificationAuditNote(requalified.map((entry) => entry.finding)));
  lines.push(...feedbackAuditNote([...feedbackByFp.values()]));

  if (kept.length === 0) {
    lines.push("No findings.", "");
  } else {
    lines.push(
      ...renderSeveritySections(
        kept.map((entry) => entry.finding),
        link,
        fingerprintFinding,
        feedbackByFp,
      ),
    );
  }

  if (requalified.length > 0) {
    lines.push(
      "<details>",
      `<summary>🔁 Addressed in stacked PRs (${requalified.length})</summary>`,
      "",
      ...requalified.flatMap(({ finding, fp }) => addressedLines(finding, fp, link)),
      "</details>",
      "",
    );
  }

  if (dropped.length > 0) {
    lines.push("<details>", `<summary>🚫 Dismissed on this PR (${dropped.length})</summary>`, "");
    for (const { finding, fp } of dropped) {
      const suffix = droppedSuffix(dismissedByFp.get(fp), feedbackByFp.get(fp));
      lines.push(
        `- **${modelText(finding.title)}** — ${location(finding, link)} \`id:${fp}\`${suffix}`,
      );
    }
    lines.push("", "_Re-add one with `/undismiss <id>`._", "</details>", "");
  }

  lines.push("---", "_This review is advisory — it never blocks a merge and never auto-approves._");
  // Embedded, machine-readable state: fingerprints (back-compat) + the full review
  // and dismissals, so `/dismiss` can re-render this comment without re-running.
  const fingerprints = review.findings.map(fingerprintFinding);
  lines.push("", `<!-- ${tag}:fingerprints=${JSON.stringify(fingerprints)} -->`);
  lines.push(
    `<!-- ${tag}:state=${encodeState(
      reviewState(
        {
          review,
          dismissed,
          ...(inputHash ? { inputHash } : {}),
          ...withMentionState(mentionState),
        },
        feedbackByFp,
        pins,
      ),
    )} -->`,
  );
  return lines.join("\n");
}

/**
 * Render sorted, severity-grouped findings. Shared by the single-comment and
 * aggregate renderers. `idFor` supplies each finding's id (default:
 * fingerprintFinding); the aggregate renderer passes a scope-namespaced id.
 */
function renderSeveritySections(
  findings: Finding[],
  link?: LinkContext,
  idFor: (finding: Finding) => string = fingerprintFinding,
  feedbackById?: Map<string, FeedbackRecord>,
): string[] {
  const out: string[] = [];
  const { inlined, listed } = splitInlined(sortFindings(findings), link, idFor);
  const groups = groupBySeverity(listed);
  for (const severity of SEVERITIES) {
    const group = groups[severity];
    if (group.length === 0) {
      continue;
    }
    out.push(`### ${severityHeading(severity)} (${group.length})`, "");
    for (const finding of group) {
      const id = idFor(finding);
      out.push(...renderFindingLines(finding, link, id, feedbackById?.get(id)));
    }
    out.push("");
  }
  out.push(...inlinedLines(inlined, feedbackById));
  return out;
}

// @ref LLP 0008#inline-threads [implements] — an inlined finding shows only its linked id in the main comment
/**
 * Split findings into those with a live inline thread and those the main comment
 * lists in full. An inlined finding is read in its thread, on the flagged line, so
 * the main comment does not repeat it. It stays in the embedded state, so `/dismiss`
 * and reply matching still find it. Order is kept.
 */
function splitInlined(
  findings: Finding[],
  link: LinkContext | undefined,
  idFor: (finding: Finding) => string,
): { inlined: { finding: Finding; id: string; url: string }[]; listed: Finding[] } {
  const inlined: { finding: Finding; id: string; url: string }[] = [];
  const listed: Finding[] = [];
  for (const finding of findings) {
    const id = idFor(finding);
    const url = validInlineUrl(link, id);
    if (url) {
      inlined.push({ finding, id, url });
    } else {
      listed.push(finding);
    }
  }
  return { inlined, listed };
}

/**
 * The findings posted as inline threads, one row per severity: each thread's id,
 * linked to the thread, plus a reply link when an author answered it. The id is
 * what `/dismiss` takes, so it must stay visible in the main comment.
 */
function inlinedLines(
  inlined: { finding: Finding; id: string; url: string }[],
  feedbackById?: Map<string, FeedbackRecord>,
): string[] {
  if (inlined.length === 0) {
    return [];
  }
  const out = [`💬 **Inline comments on the diff (${inlined.length})**`, ""];
  for (const severity of SEVERITIES) {
    const group = inlined.filter((entry) => knownSeverity(entry.finding.severity) === severity);
    if (group.length === 0) {
      continue;
    }
    const threads = group.map(({ id, url }) => {
      const reply = feedbackById?.get(id);
      const replied = reply ? ` (💬 ${replyLink(`${replyAuthor(reply)} replied`, reply)})` : "";
      return `[\`id:${id}\`](${url})${replied}`;
    });
    out.push(`- ${severityHeading(severity)}: ${threads.join(", ")}`);
  }
  out.push("");
  return out;
}

// @ref LLP 0005#comment-rendering [constrained-by] — blank lines must stay truly empty or <details> escapes the list (euxy#45)
/**
 * Indent every line of a multi-line value to a list item's content column.
 *
 * Rationales embed a `<details>` block, and only indenting the first line let
 * that HTML escape the list item: GitHub then treated the closing `</details>`
 * as ending a top-level HTML block, and because the next finding's bullet
 * followed after a single newline it was emitted as raw text instead of
 * Markdown. Every finding after the first in a group rendered with visible
 * `**` and backticks.
 *
 * Blank lines stay truly empty — trailing whitespace would make them
 * non-blank and reopen the same class of parsing bug.
 */
function indentContinuation(value: string, indent = "  "): string[] {
  return value.split("\n").map((line) => (line.trim() === "" ? "" : `${indent}${line}`));
}

function sourceLabel(value: string): string {
  return modelText(value)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\[\]])/g, "\\$1");
}

/**
 * HTML formatting tags a model writes into a rationale (`<br>`, `<details>`, ...).
 * A fixed list, not "anything in angle brackets", so a type like `Promise<void>`
 * in the prose survives.
 */
const FORMATTING_TAG_RE =
  /<\/?(?:a|b|blockquote|br|code|del|details|div|em|h[1-6]|hr|i|kbd|li|ol|p|pre|s|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul)\b[^<>]*>/gi;

/** Only ever link to github.com from a stored/returned URL (see REPLY_URL_RE). */
function validInlineUrl(link: LinkContext | undefined, id: string): string | null {
  const url = link?.inlineUrls?.get(id);
  return url && REPLY_URL_RE.test(url) ? url : null;
}

function renderFindingLines(
  finding: Finding,
  link?: LinkContext,
  id: string = fingerprintFinding(finding),
  reply?: FeedbackRecord,
): string[] {
  const out = [
    `- **${modelText(finding.title)}** — ${location(finding, link)} _(${finding.category})_ · \`id:${id}\`${replyAnnotation(reply)}`,
    ...indentContinuation(modelText(finding.rationale)),
  ];
  if (finding.sources?.length) {
    const sources = finding.sources
      .map((source) => `[${sourceLabel(source.title)}](<${source.url}>)`)
      .join(", ");
    out.push("", ...indentContinuation(`**Sources:** ${sources}`));
  }
  if (finding.suggestion) {
    // A rationale may end in raw HTML (`</details>`). GitHub requires a truly
    // blank line before it resumes Markdown parsing; without this separator the
    // suggestion's emphasis markers are rendered literally.
    out.push("", ...indentContinuation(`**Suggestion:** ${modelText(finding.suggestion)}`));
  }
  // Separator so a rationale ending in `</details>` cannot swallow the next
  // bullet. Findings are already loose list items, so this changes no spacing.
  out.push("");
  return out;
}

/**
 * Full body of one inline (PR review) finding comment: identity marker at byte 0,
 * then the finding rendered whole — everything model-written passes
 * stripStateMarkers, same as the main comment. The footer teaches the clearing
 * flow (an UNQUOTED id citation), since the main comment only counts this finding.
 * The body must never contain `:state=`/`:fingerprints=` (it would be dropped as
 * our own main comment by the reply matcher's backstop) — it doesn't.
 */
export function renderInlineCommentBody(finding: Finding, tag: string, fp: string): string {
  const lines = [
    inlineCommentMarker(tag, fp),
    `**${severityHeading(knownSeverity(finding.severity))}: ${modelText(finding.title)}** _(${finding.category})_ · \`id:${fp}\``,
    "",
    modelText(finding.rationale),
  ];
  if (finding.sources?.length) {
    const sources = finding.sources
      .map((source) => `[${sourceLabel(source.title)}](<${source.url}>)`)
      .join(", ");
    lines.push("", `**Sources:** ${sources}`);
  }
  if (finding.suggestion) {
    lines.push("", `**Suggestion:** ${modelText(finding.suggestion)}`);
  }
  lines.push(
    "",
    "---",
    `_🤖 AI review finding — reply here to respond; write \`id:${fp}\` (outside any quote) in your reply to formally answer it. Full review in the main PR comment._`,
  );
  return lines.join("\n");
}

/**
 * What a no-longer-tracked inline comment is patched to when its thread has human
 * replies (a bare one is deleted instead). Deliberately NEUTRAL: a finding leaves
 * the inline set for many reasons that are not resolution — capped out, its line
 * left the diff, aggregate-state truncation — so this text must never assert
 * "resolved" or "dismissed". The marker stays, so a returning finding revives the
 * same thread instead of opening a new one.
 */
export function inlineStubBody(tag: string, fp: string): string {
  return [
    inlineCommentMarker(tag, fp),
    "_🤖 This finding is no longer tracked inline — see the main review comment for current status._",
  ].join("\n");
}

/**
 * What the review says about a roster agent that did not run.
 */
export const AGENT_NOT_RUN_TEXT: Record<NonNullable<AgentSummary["notRun"]>, string> = {
  paths: "not run: no changed file matches its `paths`",
  router: "not run: the router did not select it",
};

/** The valid handles a set of mentions names. */
function mentionHandles(mentions: AgentMention[] = []): string[] {
  // The state is parsed back from the comment body, so check every login again.
  return mentions.flatMap(({ logins }) => logins.filter((login) => MENTION_TARGET_RE.test(login)));
}

// @ref LLP 0005#comment-rendering [implements] — a handle notifies once per comment: an edit that adds a mention notifies, so a request that drops out and comes back renders without a live mention
/**
 * Which handles this render mentions for real. A handle stays live while it stays in
 * the comment. One the comment notified before, which left and came back, renders
 * as plain text: GitHub notifies a person when an edit adds a mention of them, so a
 * request that flaps between runs would otherwise notify on every return.
 */
function nextMentionState(handles: string[], prior?: MentionState): MentionState {
  const priorLive = new Set(prior?.live ?? []);
  const priorNotified = new Set(prior?.notified ?? []);
  const live = [...new Set(handles.map((handle) => handle.toLowerCase()))].filter(
    (handle) => priorLive.has(handle) || !priorNotified.has(handle),
  );
  return { live, notified: [...new Set([...priorNotified, ...live])] };
}

/** The state field for `mentionState`, or nothing when the comment never mentioned anyone. */
function withMentionState(mentionState: MentionState): { mentioned?: MentionState } {
  return mentionState.notified.length > 0 ? { mentioned: mentionState } : {};
}

/**
 * One visible line per human review that an agent asked for, which mentions the people
 * from the agent's config. A handle not in `live` shows without notifying. Empty when
 * there are none.
 */
function mentionLines(mentions: AgentMention[] = [], live: string[] = []): string[] {
  const liveSet = new Set(live);
  return mentions.flatMap(({ agent, logins, reason }) => {
    const handles = mentionHandles([{ agent, logins, reason }]);
    if (handles.length === 0) {
      return [];
    }
    const people = handles
      .map((login) => (liveSet.has(login.toLowerCase()) ? `@${login}` : `@\u200B${login}`))
      .join(" ");
    return [
      `> 📣 ${people}: the \`${stripStateMarkers(agent)}\` reviewer asks for your review. ${plainModelLine(reason)}`,
      "",
    ];
  });
}

/**
 * `AGENT_NOT_RUN_TEXT` for `reason`. A comment's state is re-rendered without a schema
 * check (by `/dismiss`, or by an older version after a newer one added a reason), so an
 * unknown reason still reads as "not run".
 */
export function agentNotRunText(reason: string): string {
  return Object.hasOwn(AGENT_NOT_RUN_TEXT, reason)
    ? AGENT_NOT_RUN_TEXT[reason as keyof typeof AGENT_NOT_RUN_TEXT]
    : "not run";
}

/** Shown in place of the summaries a comment left out to fit GitHub's size limit. */
const AGENT_SUMMARIES_LEFT_OUT =
  "🔎 Reviewer summaries were left out to fit the comment size limit.";

/**
 * Each roster agent's own summary, or why it did not run, in a collapsed section.
 * Empty when the review has none.
 */
function agentSummariesSection(summaries: AgentSummary[] = []): string[] {
  if (summaries.length === 0) {
    return [];
  }
  const rows = summaries.map(({ agent, summary, notRun }) => {
    const text = notRun
      ? `_${agentNotRunText(notRun)}_`
      : typeof summary === "string" && summary
        ? plainModelLine(summary)
        : "_no summary_";
    return `- **${stripStateMarkers(agent)}:** ${text}`;
  });
  return [
    "<details>",
    `<summary>🔎 Reviewer summaries (${summaries.length})</summary>`,
    "",
    ...rows,
    "",
    "</details>",
    "",
  ];
}

/**
 * An HTML character reference that spells `@`: `&#64;`, `&#x40;`, `&commat;`. GitHub
 * decodes it before it looks for mentions. A reference after the `@` needs nothing:
 * that `@` is broken like any other. Others (`&lt;`, `&amp;`) still render as written.
 */
const AT_REFERENCE_RE = /&(?=#0*64;|#[xX]0*40;|commat;)/g;

/**
 * Model prose as one plain line that cannot notify anyone: formatting tags removed,
 * `@` character references and every `<` escaped, whitespace collapsed, and each `@` that
 * could start a mention broken.
 */
function plainModelLine(text: string): string {
  const flat = text
    .replace(FORMATTING_TAG_RE, " ")
    .replace(/</g, "&lt;")
    .replace(/\s+/g, " ")
    .trim();
  return breakMentions(flat);
}

/**
 * Text with every `@mention` broken, so it can never notify anyone. Only the
 * engine-owned mention lines notify people.
 */
function breakMentions(text: string): string {
  // GitHub notifies `@login` and `@org/team` when the `@` starts a text node or follows
  // a non-word character. Markdown can start a text node at almost any punctuation
  // (`_@x_` renders as `<em>@x</em>`), so only an ASCII letter or digit before the `@`
  // is safe to trust, which keeps an email address whole. Everywhere else a zero-width
  // space after the `@` keeps the text readable and stops the notification.
  return (
    text
      // Shown as typed: `&amp;#64;` renders as the text `&#64;`, never as `@`.
      .replace(AT_REFERENCE_RE, "&amp;")
      // A lookbehind, not a captured preceding character: a capture would consume the
      // first `@` of `@@login`, leave the second unmatched, and `@\u200B@login` notifies.
      .replace(/(?<![A-Za-z0-9])@/g, "@\u200B")
  );
}

/**
 * Model-written prose for the comment body: no forged state marker, and no live
 * `@mention`. Multi-line text keeps its lines and formatting.
 */
function modelText(text: string): string {
  return breakMentions(stripStateMarkers(text));
}

// @ref LLP 0012#run-points-command-and-review [implements] — setup advice renders outside the findings list, so it never blocks
/** Advice about the reviewer's own setup (stale refs, cited code this PR moves). */
function setupNote(notes: string[] = []): string[] {
  if (notes.length === 0) {
    return [];
  }
  return ["> 🔗 **Review setup:**", ...notes.map((note) => `> - ${stripStateMarkers(note)}`), ""];
}

// @ref LLP 0010#rendering-in-all-three-paths [implements] — the visible audit count is mandatory: requalification's only effect on a real finding is moving it out of the blocking set, so it must never be silent
/**
 * The visible one-line audit note in the OPEN body, naming the addressing PRs. This
 * is what keeps requalification from being a "collapsed fold nobody reads": the
 * count and PR numbers show above the fold. Empty when nothing was requalified.
 */
function requalificationAuditNote(requalified: Finding[]): string[] {
  if (requalified.length === 0) {
    return [];
  }
  const prNumbers = [
    ...new Set(
      requalified
        .map((finding) => finding.requalifiedBy?.prNumber)
        .filter((n): n is number => n != null),
    ),
  ].sort((a, b) => a - b);
  const prList = prNumbers.map((n) => `#${n}`).join(", ");
  return [
    `> 🔁 **${requalified.length} finding(s)** marked addressed by stacked PR(s) (${prList}); ` +
      "excluded from the decision but shown below.",
    "",
  ];
}

/** One bullet per finding in the "Addressed in stacked PRs" section — names the
 * addressing PR and the exact upstack path relied on. */
function addressedLines(finding: Finding, fp: string, link?: LinkContext): string[] {
  const requalified = finding.requalifiedBy!;
  const reason = requalified.reason ? `: ${modelText(requalified.reason)}` : "";
  return [
    `- **${modelText(finding.title)}** — ${location(finding, link)} \`id:${fp}\` — addressed in ` +
      `#${requalified.prNumber} (\`${stripStateMarkers(requalified.file)}\`)${reason}`,
  ];
}

/**
 * Index the feedback records that answer a finding actually present in this
 * comment, keyed by the id the comment renders. A record whose finding is gone
 * (the flagged code changed, so the fingerprint moved) is dropped: it can no
 * longer be shown, counted, or audited, so carrying it forward only grows state.
 */
function matchedFeedback(
  feedback: FeedbackRecord[],
  ids: Set<string>,
): Map<string, FeedbackRecord> {
  const matched = new Map<string, FeedbackRecord>();
  for (const record of feedback) {
    if (ids.has(record.fp) && !matched.has(record.fp)) {
      matched.set(record.fp, record);
    }
  }
  return matched;
}

// @ref LLP 0011#suppression-is-never-silent [implements] — the count sits above the fold, exactly like the requalification note, so a reply clearing a finding is never a quiet fold nobody opens
/** The visible one-line audit note for author responses. Empty when no reply
 * matched a finding in this comment. */
function feedbackAuditNote(records: FeedbackRecord[]): string[] {
  if (records.length === 0) {
    return [];
  }
  const applied = records.filter((record) => record.applied).length;
  return [
    `> 💬 **${records.length} finding(s)** have an author response (${applied} applied).`,
    "",
  ];
}

/** ` · 💬 [@login replied](url)` on an active finding — the entire visible trace
 * of a reply. The reply's own text is never part of it. */
function replyAnnotation(record?: FeedbackRecord): string {
  return record ? ` · 💬 ${replyLink(`${replyAuthor(record)} replied`, record)}` : "";
}

/** The audit tail of a "Dismissed" bullet: an explicit `/dismiss`, or the reply
 * that cleared the finding. */
function droppedSuffix(dismissal?: DismissalRecord, reply?: FeedbackRecord): string {
  if (dismissal) {
    const who = dismissal.by ? ` by @${stripStateMarkers(dismissal.by)}` : "";
    const why = dismissal.reason ? ` — ${stripStateMarkers(dismissal.reason)}` : "";
    return `${who}${why}`;
  }
  return reply ? ` — dismissed via reply by ${replyLink(replyAuthor(reply), reply)}` : "";
}

// @ref LLP 0011#the-pin-belongs-to-the-finding [implements] — the pin set rides the state on EVERY render, independent of which replies matched this run, so a reply that disappears can never drop a maintainer's restore
/** Attach the matched feedback to the state blob. It rides the embedded state
 * like dismissals do, so the next run re-reads what was recorded (including a
 * verdict already decided) instead of re-deriving it.
 *
 * `pins` is written whole and unfiltered — NOT indexed by the findings or the records
 * this render happens to show. A pin is a maintainer's decision about a finding, so it
 * must outlive a run where the reply was edited away, the record was dropped, or the
 * finding itself was not re-emitted. */
function reviewState(
  state: ReviewState,
  feedbackByFp: Map<string, FeedbackRecord>,
  pins: FeedbackPin[] = [],
): ReviewState {
  const feedback = [...feedbackByFp.values()];
  const withFeedback = feedback.length > 0 ? { ...state, feedback } : state;
  return pins.length > 0 ? { ...withFeedback, pins } : withFeedback;
}

/** Parse the fingerprints embedded in a previously-posted comment body. */
export function parseEmbeddedFingerprints(body: string, tag: string): string[] {
  // Escape the (config-controlled) tag so regex metacharacters can't break the match.
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`<!-- ${escapedTag}:fingerprints=(\\[.*?\\]) -->`));
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[1]!);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** One scope's review result, for aggregate (comment:'single') rendering. */
export interface ScopeReviewResult {
  /** Scope name. */
  scope: string;
  /** config '.' → un-namespaced fingerprints (dismissal carry-over). */
  isDefault: boolean;
  review: CoordinatorOutput;
  /** Hash of the complete input that produced `review`; absent means do not reuse. */
  inputHash?: string;
}

/** The machine-readable state embedded in the reviewer's comment. */
export interface ReviewState {
  /** v1 field, kept: the aggregate stores the MERGED output here. */
  review: CoordinatorOutput;
  dismissed: DismissalRecord[];
  /** v5: legacy/single-scope review-result cache key. */
  inputHash?: string;
  /** v2: present only on aggregate comments (routing, comment:'single'). */
  scopes?: ScopeReviewResult[];
  /** v3: author replies matched to the findings shown in this comment. */
  feedback?: FeedbackRecord[];
  /**
   * v4: the findings a maintainer restored with `/undismiss` after a reply had cleared
   * them. Stored beside the records rather than on them: a record only exists while a
   * reply still matches its finding, and the pin has to survive the author editing,
   * replacing or deleting that reply (see collectPins/applyPins). Read from a v3
   * comment, the pins are migrated out of the records themselves.
   */
  pins?: FeedbackPin[];
  /** v6: who this comment's mention lines notify, so a later render never notifies twice. */
  mentioned?: MentionState;
}

const DECISION_RANK: Record<Decision, number> = {
  approve: 0,
  approve_with_comments: 1,
  request_changes: 2,
};

/** Worst (most severe) decision across scopes. */
export function worstDecision(decisions: Decision[]): Decision {
  return decisions.reduce<Decision>(
    (worst, decision) => (DECISION_RANK[decision] > DECISION_RANK[worst] ? decision : worst),
    "approve",
  );
}

// @ref LLP 0005#truncation-and-aggregate-state [constrained-by] — truncation trims shown findings only; dismissed findings always kept in state
/**
 * One aggregated comment under the single existing marker: a scope summary table,
 * an optional coverage block, one <details> per scope (findings rendered with
 * scope-namespaced ids), and the dismissed section. The embedded v1 `review` field
 * is a synthesized merge so v1 state consumers still see a valid shape; `scopes`
 * carries the real per-scope data. An oversized body first leaves out every scope's
 * agent summaries, then trims each scope's findings to the most severe N (halving
 * until it fits, floor 3), each with a per-scope note.
 */
export function renderAggregateMarkdown(
  results: ScopeReviewResult[],
  tag: string,
  dismissed: DismissalRecord[],
  link?: LinkContext,
  opts?: { unmatchedFiles?: string[]; mentioned?: MentionState },
  feedback: FeedbackRecord[] = [],
  pins: FeedbackPin[] = [],
): string {
  const mentionState = nextMentionState(
    results.flatMap((result) => mentionHandles(result.review.mentions)),
    opts?.mentioned,
  );
  const dismissedByFp = new Map(dismissed.map((record) => [record.fp, record]));
  const idOf = (result: ScopeReviewResult, finding: Finding): string =>
    scopedFingerprint(result.isDefault ? null : result.scope, finding);
  // Feedback is keyed by the SAME scope-namespaced id the comment renders, so a
  // record can never cross scopes.
  const feedbackById = matchedFeedback(
    feedback,
    new Set(results.flatMap((result) => result.review.findings.map((f) => idOf(result, f)))),
  );

  // Split each scope's findings into kept/requalified/dropped once (dismissal and
  // requalification are both limit-independent). `kept` is the active/blocking set;
  // requalified findings are addressed by a stacked PR — counted and shown, never
  // in the blocking list.
  const perScope = results.map((result) => {
    const withId = result.review.findings.map((finding) => ({
      finding,
      id: idOf(result, finding),
    }));
    // An applied reply drops a finding out of the active list, like a dismissal.
    const isDropped = (entry: { id: string }): boolean =>
      dismissedByFp.has(entry.id) || feedbackById.get(entry.id)?.applied === true;
    const notDismissed = withId.filter((entry) => !isDropped(entry));
    return {
      result,
      kept: notDismissed.filter((entry) => !entry.finding.requalifiedBy),
      requalified: notDismissed.filter((entry) => entry.finding.requalifiedBy),
      dropped: withId.filter((entry) => isDropped(entry)),
      // The scope's own author responses, for its audit note.
      feedback: withId
        .map((entry) => feedbackById.get(entry.id))
        .filter((record): record is FeedbackRecord => record != null),
    };
  });

  const worst = worstDecision(results.map((result) => result.review.decision));
  const unmatched = opts?.unmatchedFiles ?? [];

  const buildBody = (limitPerScope: number, withSummaries: boolean): string => {
    const lines: string[] = [
      commentMarker(tag),
      "## 🤖 AI code review",
      "",
      `**Decision:** ${decisionLabel(worst)}`,
      "",
      "| Scope | Decision | Findings |",
      "| --- | --- | --- |",
    ];
    for (const { result, kept } of perScope) {
      lines.push(
        `| ${stripStateMarkers(result.scope)} | ${result.review.couldNotComplete ? "No review — every pass failed" : decisionLabel(result.review.decision)} | ${kept.length} |`,
      );
    }
    lines.push("");

    const anyIncomplete = results.some((result) => result.review.incomplete.length > 0);
    if (unmatched.length > 0 || anyIncomplete) {
      lines.push("> ⏱️ **Coverage note:** parts of this PR may not be fully reviewed:");
      if (unmatched.length > 0) {
        const shown = unmatched
          .slice(0, 10)
          .map((file) => `\`${stripStateMarkers(file)}\``)
          .join(", ");
        const more = unmatched.length > 10 ? `, …(+${unmatched.length - 10} more)` : "";
        lines.push(`> - ${unmatched.length} changed file(s) matched no scope: ${shown}${more}`);
      }
      for (const result of results) {
        for (const note of result.review.incomplete) {
          lines.push(`> - [${stripStateMarkers(result.scope)}] ${stripStateMarkers(note)}`);
        }
      }
      lines.push("");
    }

    const setupLines = results.flatMap((result) =>
      (result.review.setupNotes ?? []).map(
        (note) => `> - [${stripStateMarkers(result.scope)}] ${stripStateMarkers(note)}`,
      ),
    );
    if (setupLines.length > 0) {
      lines.push("> 🔗 **Review setup:**", ...setupLines, "");
    }

    // @ref LLP 0008#inline-threads [implements] — the size cap trims listed findings only
    // Shown = every inlined kept finding plus the most-severe N listed ones per scope
    // (N = limitPerScope). The limit applies to listed findings only: an inlined
    // finding renders as one short id link, and the inline cap (`maxComments`)
    // already bounds how many there are. Cutting the combined list would drop listed
    // findings for inlined ones, and a listed finding has nowhere else to appear.
    // The embedded state trims KEPT findings to the same set so a truncated comment
    // still fits GitHub's body limit (the hidden findings are noted, not silently
    // carried) — but dismissed findings are always kept in state (see below).
    const rendered = perScope.map(({ result, kept, requalified, dropped, feedback: replies }) => {
      const { inlined, listed } = splitInlined(
        sortFindings(kept.map((entry) => entry.finding)),
        link,
        (finding) => idOf(result, finding),
      );
      return {
        result,
        replies,
        shown: [...inlined.map((entry) => entry.finding), ...listed.slice(0, limitPerScope)],
        hidden: Math.max(0, listed.length - limitPerScope),
        // The requalified section is trimmed by the same per-scope limit as shown: it
        // is coordinator-populated (a wide stack can requalify many findings at once),
        // and an untrimmed section would keep the truncation loop below from ever
        // converging under MAX_COMMENT_CHARS. The audit note carries the TOTAL count,
        // so trimming never hides that requalification happened.
        requalified: requalified.slice(0, limitPerScope),
        requalifiedHidden: Math.max(0, requalified.length - limitPerScope),
        requalifiedAll: requalified,
        dropped,
      };
    });

    for (const {
      result,
      replies,
      shown,
      hidden,
      requalified,
      requalifiedAll,
      requalifiedHidden,
    } of rendered) {
      // @ref LLP 0011#suppression-is-never-silent — a reply-suppressed scope opens
      // its fold so the audit note is visible, matching renderMarkdown and LLP 0010's
      // visible-suppression rule (else a scope replies cleared reads as clean).
      // A human-review request opens it too: the people it notifies must find it.
      const mentions = mentionLines(result.review.mentions, mentionState.live);
      const open =
        shown.length > 0 || requalifiedAll.length > 0 || replies.length > 0 || mentions.length > 0
          ? " open"
          : "";
      const keptCount = shown.length + hidden;
      lines.push(
        `<details${open}>`,
        `<summary>${stripStateMarkers(result.scope)} — ${decisionLabel(result.review.decision)} (${keptCount})</summary>`,
        "",
      );
      if (result.review.summary) {
        lines.push(modelText(result.review.summary), "");
      }
      lines.push(...mentions);
      if (withSummaries) {
        lines.push(...agentSummariesSection(result.review.agentSummaries));
      } else if (result.review.agentSummaries?.length) {
        lines.push(AGENT_SUMMARIES_LEFT_OUT, "");
      }
      lines.push(...requalificationAuditNote(requalifiedAll.map((entry) => entry.finding)));
      lines.push(...feedbackAuditNote(replies));
      if (shown.length === 0) {
        lines.push("No findings.", "");
      } else {
        lines.push(
          ...renderSeveritySections(shown, link, (finding) => idOf(result, finding), feedbackById),
        );
      }
      if (hidden > 0) {
        lines.push(`_…and ${hidden} more finding(s) — see the workflow log._`, "");
      }
      if (requalifiedAll.length > 0) {
        lines.push(
          `**🔁 Addressed in stacked PRs (${requalifiedAll.length})**`,
          "",
          ...requalified.flatMap((entry) => addressedLines(entry.finding, entry.id, link)),
        );
        if (requalifiedHidden > 0) {
          lines.push(
            `_…and ${requalifiedHidden} more addressed finding(s) — see the workflow log._`,
          );
        }
        lines.push("");
      }
      lines.push("</details>", "");
    }

    const allDropped = perScope.flatMap(({ result, dropped }) =>
      dropped.map((entry) => ({ ...entry, scope: result.scope })),
    );
    if (allDropped.length > 0) {
      lines.push(
        "<details>",
        `<summary>🚫 Dismissed on this PR (${allDropped.length})</summary>`,
        "",
      );
      for (const { finding, id, scope } of allDropped) {
        const suffix = droppedSuffix(dismissedByFp.get(id), feedbackById.get(id));
        lines.push(
          `- **${modelText(finding.title)}** — ${location(finding, link)} \`id:${id}\` _(${stripStateMarkers(scope)})_${suffix}`,
        );
      }
      lines.push("", "_Re-add one with `/undismiss <id>`._", "</details>", "");
    }

    lines.push(
      "---",
      "_This review is advisory — it never blocks a merge and never auto-approves._",
    );

    // Embedded state carries the shown (kept) findings PLUS every dismissed one —
    // truncation may trim kept findings so the comment fits, but dismissed findings
    // must survive in state (mirroring renderMarkdown, which embeds the full
    // review) so /undismiss can restore them and the Dismissed section persists
    // across re-renders. The per-scope data (`scopes`) plus a merged v1 `review`
    // keep both v2 and v1 consumers working.
    const stateScopes: ScopeReviewResult[] = rendered.map(
      ({ result, shown, hidden, requalified, requalifiedHidden, dropped }) => {
        // @ref LLP 0011#suppression-is-never-silent — strip any per-scope `feedback`
        // a freshly-reviewed scope's ReviewRunResult carries: the top-level feedback
        // array (reviewState below) is the single source of truth. A stale per-scope
        // copy that survived here would be read back on a later carried-over run and
        // could re-apply a record a human /undismiss already overrode at the top level.
        const {
          feedback: _feedback,
          agentSummaries,
          ...rest
        } = result.review as CoordinatorOutput & {
          feedback?: unknown;
        };
        // State bytes count toward the comment size, so left-out summaries leave the
        // state too.
        const review = withSummaries && agentSummaries ? { ...rest, agentSummaries } : rest;
        return {
          scope: result.scope,
          isDefault: result.isDefault,
          // A truncated state is not the full result and therefore cannot be a cache
          // source. Omit its hash so the next run retries instead of reusing a subset.
          ...(hidden === 0 && requalifiedHidden === 0
            ? result.inputHash
              ? { inputHash: result.inputHash }
              : {}
            : {}),
          // Requalified findings ride the embedded state (like dismissed ones) so a
          // re-render (/dismiss) round-trips them and the addressed section persists.
          // Under truncation they are trimmed exactly like `shown` — state bytes count
          // toward the comment size, so an untrimmed list would defeat the cap loop.
          review: {
            ...review,
            findings: [
              ...shown,
              ...requalified.map((entry) => entry.finding),
              ...dropped.map((entry) => entry.finding),
            ],
          },
        };
      },
    );
    const merged: CoordinatorOutput = {
      decision: worst,
      findings: stateScopes.flatMap((scope) => scope.review.findings),
      summary: results
        .map((result) => `**${result.scope}:** ${result.review.summary}`)
        .join("\n\n"),
      incomplete: [...new Set(results.flatMap((result) => result.review.incomplete))],
    };
    const fingerprints = stateScopes.flatMap((scope) =>
      scope.review.findings.map((finding) =>
        scopedFingerprint(scope.isDefault ? null : scope.scope, finding),
      ),
    );
    lines.push("", `<!-- ${tag}:fingerprints=${JSON.stringify(fingerprints)} -->`);
    // Feedback records and `/undismiss` pins ride the state whole, never trimmed by the
    // cap loop: each is a handful of bytes, and losing one would lose a verdict already
    // decided — or a maintainer's restore, which no later run could recover.
    lines.push(
      `<!-- ${tag}:state=${encodeState(
        reviewState(
          { review: merged, dismissed, scopes: stateScopes, ...withMentionState(mentionState) },
          feedbackById,
          pins,
        ),
      )} -->`,
    );
    return lines.join("\n");
  };

  let limit = Number.POSITIVE_INFINITY;
  let withSummaries = true;
  let body = buildBody(limit, withSummaries);
  // Agent summaries go before any finding: they never affect the decision, and each
  // scope's summary budget does not bound the sum across scopes.
  if (body.length > MAX_COMMENT_CHARS) {
    withSummaries = false;
    body = buildBody(limit, withSummaries);
  }
  // Seed from the largest per-scope section the limit applies to — kept OR
  // requalified — so the halving loop shrinks whichever one is oversized.
  const largestScope = Math.max(
    0,
    ...perScope.map((entry) => Math.max(entry.kept.length, entry.requalified.length)),
  );
  while (body.length > MAX_COMMENT_CHARS && limit > 3) {
    limit =
      limit === Number.POSITIVE_INFINITY
        ? Math.max(3, Math.floor(largestScope / 2))
        : Math.max(3, Math.floor(limit / 2));
    body = buildBody(limit, withSummaries);
  }
  return body;
}

function encodeState(state: ReviewState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

/** Recover the embedded `{ review, dismissed }` state from a posted comment body. */
export function parseReviewState(body: string, tag: string): ReviewState | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`<!-- ${escapedTag}:state=([A-Za-z0-9+/=]+) -->`));
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as ReviewState;
    if (parsed && Array.isArray(parsed.review?.findings) && Array.isArray(parsed.dismissed)) {
      // The v3 `feedback` field is shape-validated rather than trusted: it feeds
      // the blocking decision, so a malformed blob must yield no records, not
      // junk ones. Same for the v4 `pins`.
      const feedback = FeedbackRecordSchema.array().safeParse(parsed.feedback ?? []);
      const records = feedback.success ? feedback.data : [];
      const parsedPins = FeedbackPinSchema.array().safeParse(parsed.pins ?? []);
      // Migration on read: a v3 comment stored its pins on the records themselves, so
      // collectPins lifts those into the set. Without this, the first render by this
      // version would write a state with no pins at all and silently release every
      // `/undismiss` a maintainer had already made.
      const { mentioned: rawMentioned, ...rest } = parsed;
      const mentioned = MentionStateSchema.safeParse(rawMentioned);
      return {
        ...rest,
        feedback: records,
        pins: collectPins(parsedPins.success ? parsedPins.data : [], records),
        ...(mentioned.success ? { mentioned: mentioned.data } : {}),
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function severityHeading(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "🚨 Critical";
    case "warning":
      return "⚠️ Warning";
    case "design":
      return "🏗️ Design";
    case "suggestion":
      return "💡 Suggestion";
    case "nit":
      return "🐧 Nit";
  }
}
