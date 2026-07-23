import { createHash } from "node:crypto";

import { fingerprintFinding, SEVERITIES, SEVERITY_RANK } from "./schema.js";
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
    const groups = groupBySeverity(sortFindings(kept.map((entry) => entry.finding)));
    for (const severity of SEVERITIES) {
      const group = groups[severity];
      if (group.length === 0) {
        continue;
      }
      lines.push(`### ${severityHeading(severity)} (${group.length})`, "");
      for (const finding of group) {
        lines.push(...renderFindingLines(finding, link));
      }
      lines.push("");
    }
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

function renderFindingLines(finding: Finding, link?: LinkContext): string[] {
  const out = [
    `- **${finding.title}** — ${location(finding, link)} _(${finding.category})_ · \`id:${fingerprintFinding(finding)}\``,
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

/** The machine-readable state embedded in the reviewer's comment. */
export interface ReviewState {
  review: CoordinatorOutput;
  dismissed: DismissalRecord[];
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
