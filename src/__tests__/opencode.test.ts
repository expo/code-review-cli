import { test, expect } from "bun:test";

import { isTransientApiError, AgentTimeoutError } from "../core/opencode.js";

test("classifies rate-limit / 5xx / network errors as transient", () => {
  for (const message of [
    "HTTP 429 Too Many Requests",
    "rate limit exceeded",
    "Overloaded",
    "status 503 Service Unavailable",
    "server error 500",
    "fetch failed",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "socket hang up",
  ]) {
    expect(isTransientApiError(new Error(message))).toBe(true);
  }
});

test("does not treat deterministic failures as transient", () => {
  for (const message of [
    'Agent "correctness" did not return parseable JSON after retries',
    "HTTP 400 Bad Request",
    "HTTP 401 Unauthorized",
    "HTTP 403 Forbidden",
    "invalid model id",
  ]) {
    expect(isTransientApiError(new Error(message))).toBe(false);
  }
});

test("never treats a timeout as transient (timeouts must abandon, not retry)", () => {
  // Its message mentions "timed out", but a timeout means abandon the pass.
  expect(isTransientApiError(new AgentTimeoutError("correctness", 15))).toBe(false);
});

test("tolerates non-Error thrown values", () => {
  expect(isTransientApiError("429 rate limit")).toBe(true);
  expect(isTransientApiError(undefined)).toBe(false);
  expect(isTransientApiError({ nope: true })).toBe(false);
});
