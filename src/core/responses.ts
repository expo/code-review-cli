// @ref LLP 0011#deterministic-matching — pure reply→finding matching; no IO, no `gh`, no model
import type { FeedbackRecord, Finding } from "./schema.js";

/** One human comment on the PR, as the reporter hands it over. */
export interface ReplyComment {
  id: number;
  body: string;
  login: string;
  maintainer: boolean;
  /** The commenter is the PR author (login === the PR's author login). Set by the
   * reporter from the unspoofable comment author; gates the adjudicated clear path.
   * Absent/false is fail-closed — an unresolved author can never clear a finding. */
  author?: boolean;
  url?: string;
}

/** Blockquote lines read per comment. A reply that quotes half the review is
 * either noise or an attempt to match everything at once. */
const MAX_QUOTED_LINES = 50;

/**
 * Minimum normalized length of a quoted line before it may match a title. A bare
 * `> ok` or `> +1` must never collide with a short finding title.
 */
const MIN_QUOTE_LEN = 8;

/** `id:<hex>` as it renders in the comment, in the fingerprint alphabet
 * (`dismiss.ts` sanitizes user input to the same one). */
const FINDING_ID_RE = /\bid:([a-f0-9]{6,64})\b/gi;

/**
 * Our own comment always ends with the embedded `:state=` / `:fingerprints=`
 * markers. The caller passes only non-bot comments, but matching our own body
 * would let the review answer itself, so this is the tag-independent backstop.
 */
const OWN_COMMENT_RE = /<!--[^\n]*:(?:state|fingerprints)=/;

/**
 * Markdown → comparable text: link text without the target, no backticks or
 * emphasis marks, collapsed whitespace, lowercase, no trailing punctuation. A
 * reply quoting a rendered finding title is byte-identical to it, so this only
 * has to absorb the copy-paste noise around that.
 */
export function normalizeTitle(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

/**
 * The blockquote lines (`> …`) of a comment body, in order and bounded. Fenced
 * code blocks are skipped: a `>` inside a fence is quoted CODE, not the author
 * quoting the review, and treating it as a quote would let a pasted snippet
 * match a finding nobody replied to.
 */
export function extractQuotedLines(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of body.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !/^\s*>/.test(raw)) {
      continue;
    }
    // Strip the marker plus any nesting (`>> quoted reply`).
    const text = raw.replace(/^\s*>[\s>]*/, "").trim();
    if (text === "") {
      continue;
    }
    out.push(text);
    if (out.length >= MAX_QUOTED_LINES) {
      break;
    }
  }
  return out;
}

/** The `id:<hex>` tokens a comment cites, lowercased and deduped. */
export function extractFindingIds(body: string): string[] {
  const ids = [...body.matchAll(FINDING_ID_RE)].map((match) => match[1]!.toLowerCase());
  return [...new Set(ids)];
}

// @ref LLP 0011#a-quote-annotates-an-id-clears [implements] — only an id the replier wrote OUTSIDE any blockquote counts as citing the finding
/**
 * The `id:<hex>` tokens the commenter wrote THEMSELVES — an id inside a blockquote
 * line does not count. GitHub's "Quote reply" copies the target comment verbatim with
 * every line prefixed `> `, and the untrusted PR author controls that text, so a quoted
 * title OR a quoted id may be text they planted. Only an unquoted id is a citation by
 * the replier, which is what `feedbackApplied` requires before a reply may CLEAR a
 * finding.
 */
export function extractCitedFindingIds(body: string): string[] {
  const own = body
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  return extractFindingIds(own);
}

// @ref LLP 0011#deterministic-matching [implements] — an ambiguous quote records nothing; only an id disambiguates
/**
 * Match author replies to the findings they answer. Deterministic by design: a
 * quoted line is compared to the rendered title, an `id:` token is compared to
 * the known fingerprints, and nothing else counts — no model decides which
 * finding a reply is about.
 *
 * An id in the known set wins outright and is the only way a quote shared by
 * several findings resolves; a quoted line matching 2+ findings otherwise
 * records NOTHING, because attributing pushback to the wrong finding is worse
 * than recording no pushback at all. One record per finding: when several
 * comments answer the same one, the newest (highest comment id) wins.
 *
 * `citedId` records HOW the reply names the finding: true only when the replier cited
 * the finding's id in their own words. It is independent of `opts.match` — that knob
 * selects how a reply MATCHES, while `citedId` is what `feedbackApplied` requires
 * before a reply may CLEAR (see LLP 0011).
 */
export function matchReplies(
  comments: ReplyComment[],
  findings: Array<{ finding: Finding; fp: string }>,
  opts: { match: "quote" | "id" | "both" },
): FeedbackRecord[] {
  const known = new Set(findings.map((entry) => entry.fp));
  const byTitle = new Map<string, string[]>();
  for (const { finding, fp } of findings) {
    const key = normalizeTitle(finding.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), fp]);
  }

  const newest = new Map<string, FeedbackRecord>();
  for (const comment of comments) {
    if (OWN_COMMENT_RE.test(comment.body)) {
      continue;
    }
    const matched = new Set<string>();
    // The ids this replier cited in their own words, computed whatever `match` says: a
    // quote-matched reply still records WHETHER it cites the finding, because that is
    // what decides clearing.
    const cited = new Set(extractCitedFindingIds(comment.body));
    if (opts.match !== "quote") {
      for (const id of extractFindingIds(comment.body)) {
        if (known.has(id)) {
          matched.add(id);
        }
      }
    }
    if (opts.match !== "id") {
      for (const quoted of extractQuotedLines(comment.body)) {
        const key = normalizeTitle(quoted);
        if (key.length < MIN_QUOTE_LEN) {
          continue;
        }
        const candidates = byTitle.get(key);
        // Ambiguous (2+ findings share this title): the only resolution is an id
        // in the same comment, which the pass above already recorded.
        if (candidates?.length === 1) {
          matched.add(candidates[0]!);
        }
      }
    }
    for (const fp of matched) {
      const previous = newest.get(fp);
      if (previous && previous.commentId >= comment.id) {
        continue;
      }
      newest.set(fp, {
        fp,
        by: comment.login,
        commentId: comment.id,
        ...(comment.url ? { url: comment.url } : {}),
        maintainer: comment.maintainer,
        author: comment.author,
        citedId: cited.has(fp),
        applied: false,
      });
    }
  }

  return [...newest.values()].sort((a, b) => a.fp.localeCompare(b.fp));
}
