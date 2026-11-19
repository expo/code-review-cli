// @ref LLP 0003#configured-mcp-servers [implements] — one append-only audit per run holds the call budget and the call record
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rmdir, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_RETRIES = 200;
const LOCK_DELAY_MS = 25;
// A holder keeps the lock for one file read and one append.
// A lock this old belongs to a proxy that was killed while it held it.
export const STALE_LOCK_MS = 2_000;

export type McpProxyAuditEvent =
  | { type: "reserved"; server: string; tool: string; argsBytes: number; argsSha256: string }
  | {
      type: "completed";
      server: string;
      tool: string;
      ms: number;
      outputBytes: number;
      truncated: boolean;
      isError: boolean;
    }
  | { type: "rejected"; server: string; tool: string; reason: "budget-exhausted" | "not-granted" }
  | {
      type: "refused";
      server: string;
      reason: "token-too-broad" | "token-not-scoped" | "unavailable";
      /** How many tools the server offered beyond the configured ones. */
      extraTools?: number;
    };

/** What one server did in one run, for the run log. */
export interface McpServerUsage {
  server: string;
  calls: number;
  errors: number;
  truncated: number;
  /** Calls refused because the budget was spent or the tool was not configured. */
  rejected: number;
  /** Set when the proxy refused to serve this server at all. */
  refused?: "token-too-broad" | "token-not-scoped" | "unavailable";
  tools: Record<string, number>;
}

type StoredEvent = McpProxyAuditEvent & { run?: string };

async function readEvents(path: string): Promise<StoredEvent[]> {
  let contents = "";
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return contents.split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      return [JSON.parse(line) as StoredEvent];
    } catch {
      return [];
    }
  });
}

/**
 * Remove a lock left by a killed proxy.
 * The rename is atomic, so when several waiters see the same stale lock only one of
 * them takes it away.
 */
async function breakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs < STALE_LOCK_MS) {
      return false;
    }
    const stale = `${lockPath}.stale-${randomUUID()}`;
    await rename(lockPath, stale);
    await rmdir(stale).catch(() => {});
    return true;
  } catch {
    // Another waiter broke it first, or the holder let it go.
    return false;
  }
}

/**
 * The audit is also the call budget.
 * Each Claude pass starts its own proxy process, so the count must live in a file
 * that every process of the run shares.
 */
export class McpProxyAudit {
  constructor(
    private readonly path: string,
    private readonly server: string,
    private readonly maxCalls: number,
    private readonly run?: string,
  ) {}

  async append(event: McpProxyAuditEvent): Promise<void> {
    const stored = this.run === undefined ? event : { ...event, run: this.run };
    await appendFile(
      this.path,
      `${JSON.stringify({ ...stored, timestamp: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private async withLock<T>(callback: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await breakStaleLock(lockPath)) continue;
        await delay(LOCK_DELAY_MS);
        continue;
      }
      try {
        return await callback();
      } finally {
        await rmdir(lockPath).catch(() => {});
      }
    }
    throw new Error("MCP proxy audit lock timed out");
  }

  /** Take one call from the server's budget. False when the budget is spent. */
  async reserve(tool: string, argsBytes: number, argsSha256: string): Promise<boolean> {
    return this.withLock(async () => {
      const used = (await readEvents(this.path)).filter(
        (event) => event.type === "reserved" && event.server === this.server,
      ).length;
      if (used >= this.maxCalls) {
        await this.append({
          type: "rejected",
          server: this.server,
          tool,
          reason: "budget-exhausted",
        });
        return false;
      }
      await this.append({ type: "reserved", server: this.server, tool, argsBytes, argsSha256 });
      return true;
    });
  }
}

/**
 * Sum the run's audit into one record per server, in first-seen order.
 * With `run`, only that run's events count, for an audit that several runs share.
 */
export async function readMcpServerUsage(path: string, run?: string): Promise<McpServerUsage[]> {
  const usage = new Map<string, McpServerUsage>();
  for (const event of await readEvents(path)) {
    if (typeof event.server !== "string") continue;
    if (run !== undefined && event.run !== run) continue;
    const entry = usage.get(event.server) ?? {
      server: event.server,
      calls: 0,
      errors: 0,
      truncated: 0,
      rejected: 0,
      tools: {},
    };
    usage.set(event.server, entry);
    if (event.type === "reserved") {
      entry.calls++;
      entry.tools[event.tool] = (entry.tools[event.tool] ?? 0) + 1;
    } else if (event.type === "completed") {
      if (event.isError) entry.errors++;
      if (event.truncated) entry.truncated++;
    } else if (event.type === "rejected") {
      entry.rejected++;
    } else if (event.type === "refused") {
      entry.refused = event.reason;
    }
  }
  return [...usage.values()];
}
