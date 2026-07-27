import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Rate-limit evidence, read from the OpenCode server's own log.
 *
 * Why this exists: provider throttling reaches us in two shapes. An EXPLICIT
 * failure (HTTP 429 / "rate limit" stream error) surfaces in OpenCode's log as a
 * structured ERROR line — that is proof. A SILENT one (the request is accepted
 * and parked server-side) produces no error anywhere and is indistinguishable
 * from a wedged request from the outside. So: the log watcher turns the explicit
 * case into a hard signal, and the stall path treats "stall + recent explicit
 * evidence" as throttling — the one situation where the right move is to WAIT
 * (re-sending the whole context into a limited account only makes it worse).
 *
 * During oauth runs prepareAuth points XDG_DATA_HOME at an isolated temp dir, so
 * the log we read belongs to exactly this run's server — no cross-talk with a
 * developer's own OpenCode sessions.
 */

/** The OpenCode server's log file under the active data dir. */
export function opencodeLogFile(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "log", "opencode.log");
}

/**
 * Provider throttle signatures in OpenCode log lines. Matched only against ERROR
 * lines (a chatty INFO line mentioning "retry" must not count as evidence).
 */
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests|quota exceeded/i;
const ERROR_LINE = /\blevel=ERROR\b/;

/** Count rate-limit ERROR lines in a chunk of log text. Pure, for tests. */
export function countRateLimitLines(chunk: string): number {
  let count = 0;
  for (const line of chunk.split("\n")) {
    if (ERROR_LINE.test(line) && RATE_LIMIT_PATTERN.test(line)) {
      count++;
    }
  }
  return count;
}

/** How recent explicit evidence must be for a stall to be read as throttling. */
const EVIDENCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Incremental watcher over the OpenCode server log. `check()` reads only what was
 * appended since the last call (cheap enough for poll loops); `recentlyLimited()`
 * is the signal the stall path consults. Fails soft everywhere: a missing or
 * unreadable log yields "no evidence", never an error.
 */
export class RateLimitWatch {
  /** Total rate-limit ERROR lines seen this run. */
  events = 0;
  /** Wall-clock time evidence was last SEEN (observation time, not log time). */
  lastSeenAt = 0;
  private offset = 0;

  constructor(private readonly file: string = opencodeLogFile()) {}

  /** Scan newly-appended log lines for rate-limit evidence. */
  async check(): Promise<number> {
    try {
      const handle = await open(this.file, "r");
      try {
        const { size } = await handle.stat();
        if (size < this.offset) {
          this.offset = 0; // rotated/truncated — rescan from the top
        }
        if (size === this.offset) {
          return this.events;
        }
        const length = size - this.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        this.offset = size;
        const found = countRateLimitLines(buffer.toString("utf8"));
        if (found > 0) {
          this.events += found;
          this.lastSeenAt = Date.now();
        }
      } finally {
        await handle.close();
      }
    } catch {
      // No log yet (server just started) or unreadable — no evidence, no error.
    }
    return this.events;
  }

  /** True when explicit throttle evidence appeared within the recency window. */
  recentlyLimited(now: number = Date.now()): boolean {
    return this.lastSeenAt > 0 && now - this.lastSeenAt < EVIDENCE_WINDOW_MS;
  }
}
