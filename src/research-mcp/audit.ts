import { appendFile, mkdir, readFile, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { ResearchNetworkCounts } from "./network.js";
import type { SearchResult } from "./types.js";

export type ResearchToolName = "search_platform_docs" | "fetch_platform_doc";

/**
 * Why a call was refused before it executed. Recorded WITHOUT the offending
 * input: a rejected query or URL may contain exactly the sensitive material
 * the sanitizer refused to send, so only the reason class is audited.
 */
export const RESEARCH_REJECTION_REASONS = [
  "query-rejected",
  "url-rejected",
  "budget-exhausted",
] as const;
export type ResearchRejectionReason = (typeof RESEARCH_REJECTION_REASONS)[number];

export interface ResearchRejection {
  tool: ResearchToolName;
  reason: ResearchRejectionReason;
}

export interface ResearchAuditInput {
  platform?: string;
  providers?: string[];
  query?: string;
  url?: string;
  context?: string;
}

export interface ResearchAuditResult {
  requestId: string;
  tool: ResearchToolName;
  input: ResearchAuditInput;
  results: Array<
    Pick<
      SearchResult,
      "id" | "platform" | "provider" | "sourceKind" | "title" | "url" | "passage"
    > &
      Partial<
        Pick<
          SearchResult,
          | "availability"
          | "framework"
          | "language"
          | "symbol"
          | "previousPassageId"
          | "nextPassageId"
        >
      >
  >;
  warnings: string[];
  /**
   * What this one reserved call actually spent on the network. Recorded because
   * the reservation count alone is a poor proxy: a single search can issue four
   * paid discovery requests and sixteen page downloads.
   */
  network?: ResearchNetworkCounts;
  error?: string;
}

type AuditEvent =
  | {
      type: "reserved";
      requestId: string;
      tool: ResearchToolName;
      input: ResearchAuditInput;
      timestamp: string;
    }
  | ({ type: "completed"; timestamp: string } & ResearchAuditResult)
  | {
      type: "failed";
      requestId: string;
      tool: ResearchToolName;
      input: ResearchAuditInput;
      error: string;
      timestamp: string;
    }
  | ({ type: "rejected"; timestamp: string } & ResearchRejection);

const LOCK_RETRIES = 200;
const LOCK_DELAY_MS = 10;
const MAX_AUDITED_PASSAGE_CHARACTERS = 20_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // oxlint-disable-next-line no-control-regex -- audit lines must stay single-line JSONL
  return message.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
}

function boundedResult(result: SearchResult): ResearchAuditResult["results"][number] {
  return {
    id: result.id.slice(0, 240),
    platform: result.platform,
    provider: result.provider,
    sourceKind: result.sourceKind,
    title: result.title.slice(0, 240),
    url: result.url.slice(0, 2_000),
    // This equals the direct-fetch document ceiling, so the artifact preserves the
    // exact bounded text shown to the reviewer without ever storing the raw page.
    passage: result.passage.slice(0, MAX_AUDITED_PASSAGE_CHARACTERS),
    ...(result.availability?.length
      ? { availability: result.availability.slice(0, 20).map((value) => value.slice(0, 240)) }
      : {}),
    ...(result.framework ? { framework: result.framework.slice(0, 240) } : {}),
    ...(result.language ? { language: result.language } : {}),
    ...(result.symbol ? { symbol: result.symbol.slice(0, 240) } : {}),
    ...(result.previousPassageId
      ? { previousPassageId: result.previousPassageId.slice(0, 240) }
      : {}),
    ...(result.nextPassageId ? { nextPassageId: result.nextPassageId.slice(0, 240) } : {}),
  };
}

/** Shared append-only audit and global request budget for all MCP processes in one review. */
export class ResearchAudit {
  private localReservations = 0;

  constructor(
    private readonly path: string | undefined,
    private readonly maxCalls: number,
  ) {}

  private async append(event: AuditEvent): Promise<void> {
    if (!this.path) return;
    await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async withLock<T>(callback: () => Promise<T>): Promise<T> {
    if (!this.path) return callback();
    const lockPath = `${this.path}.lock`;
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          return await callback();
        } finally {
          await rmdir(lockPath).catch(() => {});
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await delay(LOCK_DELAY_MS);
      }
    }
    throw new Error("Documentation research audit lock timed out");
  }

  private async reservationCount(): Promise<number> {
    if (!this.path) return this.localReservations;
    let contents = "";
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return contents.split("\n").reduce((count, line) => {
      if (!line) return count;
      try {
        return (JSON.parse(line) as { type?: unknown }).type === "reserved" ? count + 1 : count;
      } catch {
        return count;
      }
    }, 0);
  }

  async reserve(tool: ResearchToolName, input: ResearchAuditInput): Promise<string> {
    const requestId = randomUUID();
    await this.withLock(async () => {
      const used = await this.reservationCount();
      if (used >= this.maxCalls) {
        // Rejected events do not count as reservations, so recording the refusal
        // cannot itself consume (or extend) the budget.
        await this.append({
          type: "rejected",
          tool,
          reason: "budget-exhausted",
          timestamp: new Date().toISOString(),
        });
        throw new Error(`Documentation research call budget exhausted (${this.maxCalls})`);
      }
      if (!this.path) this.localReservations++;
      await this.append({
        type: "reserved",
        requestId,
        tool,
        input,
        timestamp: new Date().toISOString(),
      });
    });
    return requestId;
  }

  async complete(
    requestId: string,
    tool: ResearchToolName,
    input: ResearchAuditInput,
    results: SearchResult[],
    warnings: string[] = [],
    network?: ResearchNetworkCounts,
  ): Promise<void> {
    await this.append({
      type: "completed",
      requestId,
      tool,
      input,
      results: results.map(boundedResult),
      warnings: warnings.slice(0, 10).map((warning) => warning.slice(0, 500)),
      ...(network ? { network } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  async fail(
    requestId: string,
    tool: ResearchToolName,
    input: ResearchAuditInput,
    error: unknown,
  ): Promise<void> {
    await this.append({
      type: "failed",
      requestId,
      tool,
      input,
      error: boundedError(error),
      timestamp: new Date().toISOString(),
    });
  }

  /** Record a call refused before execution — reason class only, never the input. */
  async rejected(tool: ResearchToolName, reason: ResearchRejectionReason): Promise<void> {
    await this.append({
      type: "rejected",
      tool,
      reason,
      timestamp: new Date().toISOString(),
    });
  }
}

export interface ResearchAuditLog {
  records: ResearchAuditResult[];
  rejections: ResearchRejection[];
}

export async function readResearchAudit(path: string): Promise<ResearchAuditLog> {
  let contents = "";
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], rejections: [] };
    throw error;
  }
  const records: ResearchAuditResult[] = [];
  const rejections: ResearchRejection[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as AuditEvent;
      if (event.type === "completed") records.push(event);
      if (event.type === "failed") {
        records.push({
          requestId: event.requestId,
          tool: event.tool,
          input: event.input,
          results: [],
          warnings: [],
          error: event.error,
        });
      }
      if (
        event.type === "rejected" &&
        RESEARCH_REJECTION_REASONS.includes(event.reason as ResearchRejectionReason)
      ) {
        rejections.push({ tool: event.tool, reason: event.reason });
      }
    } catch {
      // Ignore a partial final line from a process that was terminated mid-write.
    }
  }
  return { records, rejections };
}
