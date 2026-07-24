import { createHash } from "node:crypto";

import { fingerprintFinding, scopedFingerprint, SEVERITIES, SEVERITY_RANK } from "./schema.js";
import type { CoordinatorOutput, Decision, DismissalRecord, Finding, Severity } from "./schema.js";

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

const DECISION_LABEL: Record<Decision, string> = {
  approve: "Approve",
  approve_with_comments: "Approve with comments",
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
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const groups: Record<Severity, Finding[]> = { critical: [], warning: [], suggestion: [] };
  for (const finding of findings) {
    groups[finding.severity].push(finding);
  }
  return groups;
}

/** HTML marker identifying the reviewer's single PR comment (used for upsert). */
export function commentMarker(tag: string): string {
  return `<!-- ${tag} -->`;
}

function locationText(finding: Finding): string {
  return finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
}

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
    const url = `https://github.com/${link.repo}/blob/${link.baseSha}/${finding.file}${lineAnchor}`;
    return `[\`${text}\`](${url})`;
  }
  return `\`${text}\``;
}

/**
 * GitHub comment body. The marker + embedded state enable in-place updates and
 * per-PR dismissals. Findings whose fingerprint appears in `dismissed` render in a
 * collapsed "Dismissed" section instead of the main list.
 */
export function renderMarkdown(
  review: CoordinatorOutput,
  tag: string,
  dismissed: DismissalRecord[] = [],
  link?: LinkContext,
): string {
  const dismissedByFp = new Map(dismissed.map((record) => [record.fp, record]));
  const withFp = review.findings.map((finding) => ({ finding, fp: fingerprintFinding(finding) }));
  const kept = withFp.filter(({ fp }) => !dismissedByFp.has(fp));
  const dropped = withFp.filter(({ fp }) => dismissedByFp.has(fp));

  const lines: string[] = [commentMarker(tag), "## 🤖 AI code review", ""];
  lines.push(`**Decision:** ${decisionLabel(review.decision)}`, "", review.summary, "");

  if (review.incomplete.length > 0) {
    lines.push(
      "> ⏱️ **Coverage note:** coverage is partial — some review passes did not",
      "> finish (timed out or failed), so issues may exist in areas not fully reviewed:",
      ...review.incomplete.map((note) => `> - ${note}`),
      "",
    );
  }

  if (kept.length === 0) {
    lines.push("No findings.", "");
  } else {
    lines.push(
      ...renderSeveritySections(
        kept.map((entry) => entry.finding),
        link,
      ),
    );
  }

  if (dropped.length > 0) {
    lines.push("<details>", `<summary>🚫 Dismissed on this PR (${dropped.length})</summary>`, "");
    for (const { finding, fp } of dropped) {
      const record = dismissedByFp.get(fp)!;
      const who = record.by ? ` by @${record.by}` : "";
      const why = record.reason ? ` — ${record.reason}` : "";
      lines.push(`- **${finding.title}** — ${location(finding, link)} \`id:${fp}\`${who}${why}`);
    }
    lines.push("", "_Re-add one with `/undismiss <id>`._", "</details>", "");
  }

  lines.push("---", "_This review is advisory — it never blocks a merge and never auto-approves._");
  // Embedded, machine-readable state: fingerprints (back-compat) + the full review
  // and dismissals, so `/dismiss` can re-render this comment without re-running.
  const fingerprints = review.findings.map(fingerprintFinding);
  lines.push("", `<!-- ${tag}:fingerprints=${JSON.stringify(fingerprints)} -->`);
  lines.push(`<!-- ${tag}:state=${encodeState({ review, dismissed })} -->`);
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
): string[] {
  const out: string[] = [];
  const groups = groupBySeverity(sortFindings(findings));
  for (const severity of SEVERITIES) {
    const group = groups[severity];
    if (group.length === 0) {
      continue;
    }
    out.push(`### ${severityHeading(severity)} (${group.length})`, "");
    for (const finding of group) {
      out.push(...renderFindingLines(finding, link, idFor(finding)));
    }
    out.push("");
  }
  return out;
}

function renderFindingLines(
  finding: Finding,
  link?: LinkContext,
  id: string = fingerprintFinding(finding),
): string[] {
  const out = [
    `- **${finding.title}** — ${location(finding, link)} _(${finding.category})_ · \`id:${id}\``,
    `  ${finding.rationale}`,
  ];
  if (finding.suggestion) {
    out.push(`  _Suggestion:_ ${finding.suggestion}`);
  }
  return out;
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
}

/** The machine-readable state embedded in the reviewer's comment. */
export interface ReviewState {
  /** v1 field, kept: the aggregate stores the MERGED output here. */
  review: CoordinatorOutput;
  dismissed: DismissalRecord[];
  /** v2: present only on aggregate comments (routing, comment:'single'). */
  scopes?: ScopeReviewResult[];
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

/** GitHub's comment body limit is ~65k chars; keep a margin. */
const MAX_COMMENT_CHARS = 60_000;

/**
 * One aggregated comment under the single existing marker: a scope summary table,
 * an optional coverage block, one <details> per scope (findings rendered with
 * scope-namespaced ids), and the dismissed section. The embedded v1 `review` field
 * is a synthesized merge so v1 state consumers still see a valid shape; `scopes`
 * carries the real per-scope data. Oversized bodies trim each scope's findings to
 * the most severe N (halving until it fits, floor 3) with a per-scope note.
 */
export function renderAggregateMarkdown(
  results: ScopeReviewResult[],
  tag: string,
  dismissed: DismissalRecord[],
  link?: LinkContext,
  opts?: { unmatchedFiles?: string[] },
): string {
  const dismissedByFp = new Map(dismissed.map((record) => [record.fp, record]));
  const idOf = (result: ScopeReviewResult, finding: Finding): string =>
    scopedFingerprint(result.isDefault ? null : result.scope, finding);

  // Split each scope's findings into kept/dropped once (dismissal is limit-independent).
  const perScope = results.map((result) => {
    const withId = result.review.findings.map((finding) => ({
      finding,
      id: idOf(result, finding),
    }));
    return {
      result,
      kept: withId.filter((entry) => !dismissedByFp.has(entry.id)),
      dropped: withId.filter((entry) => dismissedByFp.has(entry.id)),
    };
  });

  const worst = worstDecision(results.map((result) => result.review.decision));
  const unmatched = opts?.unmatchedFiles ?? [];

  const buildBody = (limitPerScope: number): string => {
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
      lines.push(`| ${result.scope} | ${decisionLabel(result.review.decision)} | ${kept.length} |`);
    }
    lines.push("");

    const anyIncomplete = results.some((result) => result.review.incomplete.length > 0);
    if (unmatched.length > 0 || anyIncomplete) {
      lines.push("> ⏱️ **Coverage note:** parts of this PR may not be fully reviewed:");
      if (unmatched.length > 0) {
        const shown = unmatched
          .slice(0, 10)
          .map((file) => `\`${file}\``)
          .join(", ");
        const more = unmatched.length > 10 ? `, …(+${unmatched.length - 10} more)` : "";
        lines.push(`> - ${unmatched.length} changed file(s) matched no scope: ${shown}${more}`);
      }
      for (const result of results) {
        for (const note of result.review.incomplete) {
          lines.push(`> - [${result.scope}] ${note}`);
        }
      }
      lines.push("");
    }

    // Shown = the most-severe N kept findings per scope (N = limitPerScope). The
    // embedded state trims KEPT findings to the same set so a truncated comment
    // still fits GitHub's body limit (the hidden findings are noted, not silently
    // carried) — but dismissed findings are always kept in state (see below).
    const rendered = perScope.map(({ result, kept, dropped }) => ({
      result,
      shown: sortFindings(kept.map((entry) => entry.finding)).slice(0, limitPerScope),
      hidden: Math.max(0, kept.length - limitPerScope),
      dropped,
    }));

    for (const { result, shown, hidden } of rendered) {
      const open = shown.length > 0 ? " open" : "";
      const keptCount = shown.length + hidden;
      lines.push(
        `<details${open}>`,
        `<summary>${result.scope} — ${decisionLabel(result.review.decision)} (${keptCount})</summary>`,
        "",
      );
      if (result.review.summary) {
        lines.push(result.review.summary, "");
      }
      if (shown.length === 0) {
        lines.push("No findings.", "");
      } else {
        lines.push(...renderSeveritySections(shown, link, (finding) => idOf(result, finding)));
      }
      if (hidden > 0) {
        lines.push(`_…and ${hidden} more finding(s) — see the workflow log._`, "");
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
        const record = dismissedByFp.get(id)!;
        const who = record.by ? ` by @${record.by}` : "";
        const why = record.reason ? ` — ${record.reason}` : "";
        lines.push(
          `- **${finding.title}** — ${location(finding, link)} \`id:${id}\` _(${scope})_${who}${why}`,
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
    const stateScopes: ScopeReviewResult[] = rendered.map(({ result, shown, dropped }) => ({
      scope: result.scope,
      isDefault: result.isDefault,
      review: { ...result.review, findings: [...shown, ...dropped.map((entry) => entry.finding)] },
    }));
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
    lines.push(
      `<!-- ${tag}:state=${encodeState({ review: merged, dismissed, scopes: stateScopes })} -->`,
    );
    return lines.join("\n");
  };

  let limit = Number.POSITIVE_INFINITY;
  let body = buildBody(limit);
  const largestScope = Math.max(0, ...perScope.map((entry) => entry.kept.length));
  while (body.length > MAX_COMMENT_CHARS && limit > 3) {
    limit =
      limit === Number.POSITIVE_INFINITY
        ? Math.max(3, Math.floor(largestScope / 2))
        : Math.max(3, Math.floor(limit / 2));
    body = buildBody(limit);
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
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

function severityHeading(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "🔴 Critical";
    case "warning":
      return "🟡 Warning";
    case "suggestion":
      return "🔵 Suggestion";
  }
}
