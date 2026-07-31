import { test, expect } from "bun:test";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isRateLimitError, stallAction } from "../core/opencode.js";
import { countRateLimitLines, opencodeLogFile, RateLimitWatch } from "../core/throttle.js";

const MIN = 60_000;

test("only ERROR lines with a throttle signature count as evidence", () => {
  const chunk = [
    // Real evidence, in OpenCode's logfmt shape.
    'timestamp=x level=ERROR message="stream error" agent=security error.error="AI_APICallError: 429 Too Many Requests"',
    'timestamp=x level=ERROR message="stream error" error.error="Rate limit reached for gpt-5.5"',
    // NOT evidence: an INFO line that merely mentions retrying…
    "timestamp=x level=INFO message=retry attempt=2",
    // …an ERROR with no throttle signature…
    'timestamp=x level=ERROR message="stream error" error.error="AI_APICallError: An error occurred"',
    // …and a 429-looking number on an INFO line (timestamps contain .429Z!).
    "timestamp=2026-07-23T05:20:31.429Z level=INFO message=process",
  ].join("\n");
  expect(countRateLimitLines(chunk)).toBe(2);
});

test("the watch reads incrementally and reports recency", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-throttle-"));
  const file = path.join(dir, "opencode.log");
  await writeFile(file, "timestamp=x level=INFO message=init\n");

  const watch = new RateLimitWatch(file);
  expect(await watch.check()).toBe(0);
  expect(watch.recentlyLimited()).toBe(false);

  await appendFile(file, 'timestamp=x level=ERROR message="stream error" error.error="429"\n');
  expect(await watch.check()).toBe(1);
  expect(watch.recentlyLimited()).toBe(true);
  // Evidence goes stale outside the recency window.
  expect(watch.recentlyLimited(Date.now() + 10 * MIN)).toBe(false);

  // Already-read lines are never recounted.
  expect(await watch.check()).toBe(1);
});

test("a missing log file is no evidence, not an error", async () => {
  const watch = new RateLimitWatch("/nonexistent/opencode.log");
  expect(await watch.check()).toBe(0);
  expect(watch.recentlyLimited()).toBe(false);
});

test("log path honors XDG_DATA_HOME (the isolated run dir)", () => {
  expect(opencodeLogFile({ XDG_DATA_HOME: "/isolated" })).toBe(
    "/isolated/opencode/log/opencode.log",
  );
});

// ---- patient stall behavior ----

test("a stall WITH rate-limit evidence waits instead of retrying — and keeps waiting", () => {
  // Waiting must not consume the single wedged retry: patience is free while
  // budget remains, whatever the retry history.
  expect(stallAction(0, 20 * MIN, true)).toBe("wait");
  expect(stallAction(1, 20 * MIN, true)).toBe("wait");
  // Out of room: salvage what exists rather than waiting past the deadline.
  expect(stallAction(0, 2 * MIN, true)).toBe("soft-land");
});

test("a stall WITHOUT evidence keeps the wedged-retry behavior", () => {
  expect(stallAction(0, 20 * MIN, false)).toBe("retry");
  expect(stallAction(1, 20 * MIN, false)).toBe("soft-land");
});

test("note() records evidence for an engine with no log file (Claude Code)", () => {
  const watch = new RateLimitWatch("/nonexistent/opencode.log");
  expect(watch.events).toBe(0);
  expect(watch.recentlyLimited()).toBe(false);
  watch.note();
  expect(watch.events).toBe(1);
  expect(watch.recentlyLimited()).toBe(true);
  watch.note(2);
  expect(watch.events).toBe(3);
});

test("rate-limit errors are recognized for the slower backoff schedule", () => {
  expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  expect(isRateLimitError(new Error("Rate limit reached for requests"))).toBe(true);
  expect(isRateLimitError(new Error("server error 503"))).toBe(false);
});
