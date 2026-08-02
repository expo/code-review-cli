// @ref LLP 0011#deterministic-matching [implements] — retroactive crawl: findings come from
// the bot's own past comment (already embeds them), so history is minable with no re-review
import { loadReviewConfig } from "../config/load.js";
import type { LoadedConfig } from "../config/schema.js";
import { repoRoot, resolveRepo, resolveTrustedTool, run } from "../core/exec.js";
import { runGrowableQueue } from "../core/review.js";
import { normalizeTitle } from "../core/responses.js";
import type { Finding, FeedbackRecord } from "../core/schema.js";
import { errorMessage } from "../core/util.js";
import { GitHubReporter } from "../reporters/github.js";

const USAGE = `ecr feedback — report what humans pushed back on

Usage:
  ecr feedback [--repo <owner/repo>] [--limit <n>] [--state <all|open|closed|merged>]
               [--since <YYYY-MM-DD>] [--as <login>] [--json]

Crawls PRs on GitHub and matches non-bot replies to the findings the reviewer's
OWN comment already embeds — retroactively, on history, with no re-review and
no model call. Reports totals, breakdowns by category/severity/agent, and the
"repeat offenders": findings whose title recurs across PRs and drew a reply
every time.

Options:
  --repo <owner/repo>   Repo to scan (else resolved from the current checkout).
  --limit <n>           Max PRs to scan, newest first (default 50).
  --state <s>           PR state: all|open|closed|merged (default all).
  --since <YYYY-MM-DD>  Only PRs updated on or after this date.
  --as <login>          The login the reviewer comments were posted under
                        (default github-actions[bot], the scaffolded workflow's
                        identity). Without it, a local crawl would look for
                        comments authored by YOUR gh login and find none.
  --json                Emit the report as a stable JSON object instead of text.
`;

interface FeedbackArgs {
  repo?: string;
  limit: number;
  state: "all" | "open" | "closed" | "merged";
  since?: string;
  /** Login the reviewer comments were posted under (see --as in USAGE). */
  as: string;
  json: boolean;
}

const VALID_STATES = new Set(["all", "open", "closed", "merged"]);

/** Same convention as review.ts: a flag's value must exist and not be a flag. */
function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): FeedbackArgs {
  const args: FeedbackArgs = { limit: 50, state: "all", as: "github-actions[bot]", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--repo":
        args.repo = requireValue(arg, argv[++i]);
        break;
      case "--limit": {
        const value = Number(requireValue(arg, argv[++i]));
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--limit requires a positive integer");
        }
        args.limit = value;
        break;
      }
      case "--state": {
        const value = requireValue(arg, argv[++i]);
        if (!VALID_STATES.has(value)) {
          throw new Error("--state must be one of: all, open, closed, merged");
        }
        args.state = value as FeedbackArgs["state"];
        break;
      }
      case "--since": {
        const value = requireValue(arg, argv[++i]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new Error("--since requires a YYYY-MM-DD date");
        }
        args.since = value;
        break;
      }
      case "--as":
        args.as = requireValue(arg, argv[++i]);
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Pure aggregation — no IO, no `gh`. Everything below this comment is what the
// checker/tests exercise over a fixture; the IO wrapper further down only
// fetches the raw material and hands it in.
// ---------------------------------------------------------------------------

/** One PR's crawled material: the findings its own reviewer comment embedded
 * (empty when the PR never got a bot comment) plus the replies matched to them. */
export interface PrFeedbackData {
  number: number;
  title: string;
  url: string;
  /** False when no parseable reviewer comment was found — the PR still counts
   * as scanned, just not as "with a bot comment". */
  hasComment: boolean;
  findings: Array<{ finding: Finding; fp: string }>;
  records: FeedbackRecord[];
}

export interface FeedbackTotals {
  prsScanned: number;
  prsWithComment: number;
  findingsSurfaced: number;
  findingsReplied: number;
  /** findingsReplied / findingsSurfaced, 0 when nothing was surfaced. */
  replyRate: number;
}

export interface FeedbackBreakdownEntry {
  key: string;
  findings: number;
  replied: number;
}

export interface RepeatOffenderOccurrence {
  pr: number;
  url: string;
  by: string;
  commentUrl?: string;
}

/** A finding title that recurred across 2+ PRs and drew a reply EVERY time —
 * the highest-value output: it surfaces "this was rejected before, for the
 * same reason". One occurrence per PR (the one that answered it). */
export interface RepeatOffender {
  title: string;
  occurrences: RepeatOffenderOccurrence[];
}

export interface FeedbackPrEntry {
  pr: number;
  title: string;
  url: string;
  findings: Array<{ title: string; by: string; commentUrl?: string }>;
}

export interface FeedbackReport {
  totals: FeedbackTotals;
  byCategory: FeedbackBreakdownEntry[];
  bySeverity: FeedbackBreakdownEntry[];
  byAgent: FeedbackBreakdownEntry[];
  repeatOffenders: RepeatOffender[];
  perPr: FeedbackPrEntry[];
}

function feedbackTotals(prs: PrFeedbackData[]): FeedbackTotals {
  const prsWithComment = prs.filter((pr) => pr.hasComment).length;
  const findingsSurfaced = prs.reduce((sum, pr) => sum + pr.findings.length, 0);
  const findingsReplied = prs.reduce((sum, pr) => sum + pr.records.length, 0);
  return {
    prsScanned: prs.length,
    prsWithComment,
    findingsSurfaced,
    findingsReplied,
    replyRate: findingsSurfaced > 0 ? findingsReplied / findingsSurfaced : 0,
  };
}

/** Group findings by a caller-chosen key (category/severity/agent), each with
 * how many were surfaced vs. actually replied to. Sorted by volume, then key. */
function breakdown(
  prs: PrFeedbackData[],
  keyOf: (finding: Finding) => string,
): FeedbackBreakdownEntry[] {
  const counts = new Map<string, { findings: number; replied: number }>();
  for (const pr of prs) {
    const repliedFps = new Set(pr.records.map((record) => record.fp));
    for (const { finding, fp } of pr.findings) {
      const key = keyOf(finding);
      const entry = counts.get(key) ?? { findings: 0, replied: 0 };
      entry.findings++;
      if (repliedFps.has(fp)) {
        entry.replied++;
      }
      counts.set(key, entry);
    }
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.findings - a.findings || a.key.localeCompare(b.key));
}

/**
 * Findings whose normalized title appears in 2+ distinct PRs, where EVERY one
 * of those PRs drew a reply to it — not just some. A title that recurred three
 * times but only got answered once is noise, not a pattern; this is deliberately
 * stricter than "recurred and got at least one reply" for that reason.
 */
function repeatOffenders(prs: PrFeedbackData[]): RepeatOffender[] {
  interface Occurrence extends RepeatOffenderOccurrence {
    replied: boolean;
  }
  const byTitle = new Map<string, { display: string; byPr: Map<number, Occurrence[]> }>();

  for (const pr of prs) {
    const byFp = new Map(pr.records.map((record) => [record.fp, record]));
    for (const { finding, fp } of pr.findings) {
      const key = normalizeTitle(finding.title);
      if (!key) {
        continue;
      }
      const record = byFp.get(fp);
      const group = byTitle.get(key) ?? { display: finding.title.trim(), byPr: new Map() };
      const occurrence: Occurrence = {
        pr: pr.number,
        url: pr.url,
        by: record?.by ?? "",
        ...(record?.url ? { commentUrl: record.url } : {}),
        replied: record !== undefined,
      };
      group.byPr.set(pr.number, [...(group.byPr.get(pr.number) ?? []), occurrence]);
      byTitle.set(key, group);
    }
  }

  const offenders: RepeatOffender[] = [];
  for (const { display, byPr } of byTitle.values()) {
    const prNumbers = [...byPr.keys()];
    if (prNumbers.length < 2) {
      continue;
    }
    const answeredEveryTime = prNumbers.every((n) => byPr.get(n)!.some((o) => o.replied));
    if (!answeredEveryTime) {
      continue;
    }
    const occurrences = prNumbers
      .sort((a, b) => a - b)
      .map((n) => byPr.get(n)!.find((o) => o.replied)!)
      .map(({ pr, url, by, commentUrl }) => ({
        pr,
        url,
        by,
        ...(commentUrl ? { commentUrl } : {}),
      }));
    offenders.push({ title: display, occurrences });
  }
  return offenders.sort(
    (a, b) => b.occurrences.length - a.occurrences.length || a.title.localeCompare(b.title),
  );
}

function perPrEntries(prs: PrFeedbackData[]): FeedbackPrEntry[] {
  return prs
    .filter((pr) => pr.records.length > 0)
    .map((pr) => {
      const byFp = new Map(pr.records.map((record) => [record.fp, record]));
      const findings = pr.findings
        .filter(({ fp }) => byFp.has(fp))
        .map(({ finding, fp }) => {
          const record = byFp.get(fp)!;
          return {
            title: finding.title.trim(),
            by: record.by,
            ...(record.url ? { commentUrl: record.url } : {}),
          };
        });
      return { pr: pr.number, title: pr.title, url: pr.url, findings };
    })
    .sort((a, b) => b.pr - a.pr);
}

/**
 * The whole report, from already-fetched material — no `gh`, no network, so
 * it is exercised over a fixture. `prs` includes every PR the crawl looked at,
 * with or without a bot comment, so "PRs scanned" and "PRs with a bot comment"
 * can differ.
 */
export function aggregateFeedback(prs: PrFeedbackData[]): FeedbackReport {
  return {
    totals: feedbackTotals(prs),
    byCategory: breakdown(prs, (finding) => finding.category),
    bySeverity: breakdown(prs, (finding) => finding.severity),
    byAgent: breakdown(prs, (finding) => finding.agent ?? "unknown"),
    repeatOffenders: repeatOffenders(prs),
    perPr: perPrEntries(prs),
  };
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Human-readable rendering of a report, in the order the spec calls for:
 * totals, breakdowns, repeat offenders, then the per-PR list. Pure. */
export function formatFeedbackReport(report: FeedbackReport): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push(
    `PRs scanned: ${t.prsScanned} (${t.prsWithComment} with a bot comment)`,
    `Findings surfaced: ${t.findingsSurfaced}`,
    `Findings with an author reply: ${t.findingsReplied} (${pct(t.replyRate)})`,
    "",
  );

  const renderBreakdown = (title: string, entries: FeedbackBreakdownEntry[]): void => {
    lines.push(`${title}:`);
    if (entries.length === 0) {
      lines.push("  (none)");
    }
    for (const entry of entries) {
      lines.push(`  ${entry.key}: ${entry.findings} surfaced, ${entry.replied} replied`);
    }
    lines.push("");
  };
  renderBreakdown("By category", report.byCategory);
  renderBreakdown("By severity", report.bySeverity);
  renderBreakdown("By agent", report.byAgent);

  lines.push("Repeat offenders (recurred across PRs, answered every time):");
  if (report.repeatOffenders.length === 0) {
    lines.push("  (none)");
  }
  for (const offender of report.repeatOffenders) {
    lines.push(`  "${offender.title}" — ${offender.occurrences.length} PRs`);
    for (const occ of offender.occurrences) {
      lines.push(
        `    ${occ.url} — @${occ.by || "unknown"}${occ.commentUrl ? ` (${occ.commentUrl})` : ""}`,
      );
    }
  }
  lines.push("");

  lines.push("Per PR:");
  if (report.perPr.length === 0) {
    lines.push("  (none)");
  }
  for (const pr of report.perPr) {
    lines.push(`  #${pr.pr} ${pr.title} (${pr.url})`);
    for (const finding of pr.findings) {
      lines.push(
        `    "${finding.title}" — @${finding.by || "unknown"}${finding.commentUrl ? ` (${finding.commentUrl})` : ""}`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// IO wrapper — the only part that talks to `gh`.
// ---------------------------------------------------------------------------

export interface RawPr {
  number: number;
  title: string;
  url: string;
  updatedAt?: string;
}

/** A PR the crawl could not fetch material for (e.g. a transient `gh api`
 * error) — recorded and skipped so one bad PR never aborts the whole crawl. */
export interface FailedPrFeedback {
  number: number;
  title: string;
  url: string;
  error: string;
}

export interface CrawlResult {
  prs: PrFeedbackData[];
  failed: FailedPrFeedback[];
}

/**
 * One PR's material, via the reporter that already owns comment fetching,
 * pagination, and matching (`GitHubReporter.collectFeedback`) — this command
 * does not talk to `gh` for comments itself, only for the PR list below.
 * `readState()` is the only way to tell "no bot comment" apart from "a bot
 * comment with zero findings", so it is checked first; `collectFeedback()` is
 * skipped entirely when there is no comment to match against.
 */
async function fetchPrFeedback(
  pr: RawPr,
  repo: string,
  config: LoadedConfig,
  cwd: string,
  botLogin: string,
): Promise<PrFeedbackData> {
  const reporter = new GitHubReporter({
    prNumber: pr.number,
    repo,
    commentTag: config.commentTag,
    breakGlassMarker: config.breakGlassMarker,
    cwd,
    feedback: config.feedback,
    // The crawl reads comments CI posted; the local gh identity would match
    // nothing (read-only use, this reporter never posts).
    ownLogin: botLogin,
  });
  const state = await reporter.readState();
  if (!state) {
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      hasComment: false,
      findings: [],
      records: [],
    };
  }
  const { findings, records } = await reporter.collectFeedback();
  return { number: pr.number, title: pr.title, url: pr.url, hasComment: true, findings, records };
}

// PRs are crawled with bounded concurrency so a `--limit` of hundreds doesn't
// fire hundreds of simultaneous `gh api` calls at once.
const CRAWL_CONCURRENCY = 4;

/**
 * Runs `fetchOne` over `prs` through `runGrowableQueue`, isolating each PR's
 * failure from the rest: a transient `gh api` error on one PR is recorded in
 * `failed` and that PR is skipped, but every other PR still gets crawled and
 * the report is still produced — one bad fetch must never lose the whole
 * multi-PR report. Pure aside from calling `fetchOne`, so the queue/isolation
 * behavior is unit-testable without `gh`.
 */
export async function crawlPrFeedback(
  prs: RawPr[],
  concurrency: number,
  fetchOne: (pr: RawPr) => Promise<PrFeedbackData>,
  onProgress: (scanned: number, total: number) => void,
): Promise<CrawlResult> {
  const results: Array<PrFeedbackData | undefined> = Array.from({ length: prs.length });
  const failed: FailedPrFeedback[] = [];
  let scanned = 0;
  await runGrowableQueue(
    prs.map((pr, index) => ({ pr, index })),
    concurrency,
    async ({ pr, index }) => {
      try {
        results[index] = await fetchOne(pr);
      } catch (error) {
        failed.push({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          error: errorMessage(error),
        });
      }
      scanned++;
      onProgress(scanned, prs.length);
    },
  );
  return { prs: results.filter((pr): pr is PrFeedbackData => pr !== undefined), failed };
}

async function crawlFeedback(
  args: FeedbackArgs,
  repo: string,
  config: LoadedConfig,
  cwd: string,
  onProgress: (scanned: number, total: number) => void,
): Promise<CrawlResult> {
  const gh = await resolveTrustedTool("gh");
  const listArgs = [
    "pr",
    "list",
    "--repo",
    repo,
    "--limit",
    String(args.limit),
    "--state",
    args.state,
    "--json",
    "number,title,url,updatedAt",
  ];
  if (args.since) {
    listArgs.push("--search", `updated:>=${args.since}`);
  }
  const { stdout } = await run(gh, listArgs, { cwd });
  const prs = JSON.parse(stdout) as RawPr[];

  return crawlPrFeedback(
    prs,
    CRAWL_CONCURRENCY,
    (pr) => fetchPrFeedback(pr, repo, config, cwd, args.as),
    onProgress,
  );
}

/** CLI wrapper: parse flags, crawl, aggregate, print. Makes no model calls. */
export async function feedbackCommand(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  let args: FeedbackArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const root = await repoRoot();
  if (root && root !== process.cwd()) {
    process.chdir(root);
  }
  const cwd = process.cwd();

  try {
    const config = await loadReviewConfig(cwd);
    const repo = args.repo ?? (await resolveRepo(cwd));
    const { prs, failed } = await crawlFeedback(args, repo, config, cwd, (scanned, total) => {
      process.stderr.write(`  scanned PR ${scanned}/${total}…\n`);
    });
    if (failed.length > 0) {
      process.stderr.write(
        `warning: skipped ${failed.length} PR(s) that failed to fetch: ` +
          `${failed.map((pr) => `#${pr.number} (${pr.error})`).join(", ")}\n`,
      );
    }
    const report = aggregateFeedback(prs);

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...report, failed })}\n`);
    } else {
      process.stdout.write(`${formatFeedbackReport(report)}\n`);
    }
  } catch (error) {
    process.stderr.write(`feedback failed: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
