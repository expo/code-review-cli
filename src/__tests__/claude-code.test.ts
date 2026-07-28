import { test, expect } from "bun:test";

import {
  buildClaudeArgs,
  buildEngineMap,
  claudeTemperatureNote,
  claudeTokenCredential,
  classifyClaudeError,
  claudeModelId,
  claudeModelMatches,
  engineForModel,
  parseClaudeResult,
  usageLimitMessage,
  usageLimitResetMs,
} from "../core/claude-code.js";
import { isTransientApiError } from "../core/opencode.js";
import type { AuthConfigEntry, LoadedConfig } from "../config/schema.js";

const entry = (over: Partial<AuthConfigEntry>): AuthConfigEntry => ({
  provider: "anthropic",
  mode: "api-key",
  ...over,
});

test("engineForModel: anthropic model ⇒ claude-code; any other provider ⇒ opencode", () => {
  // ALL anthropic models run through the Claude Code CLI — inferred from the model
  // alone, independent of auth (mode is no longer consulted).
  expect(engineForModel("anthropic/claude-opus-5")).toBe("claude-code");
  expect(engineForModel("anthropic/claude-sonnet-5")).toBe("claude-code");
  // Any other provider → opencode.
  expect(engineForModel("openai/gpt-5.5")).toBe("opencode");
  expect(engineForModel("google/gemini-3-pro")).toBe("opencode");
  // A bare id has no `anthropic/` prefix, so its provider is the whole string → opencode.
  expect(engineForModel("opus")).toBe("opencode");
});

test("buildEngineMap: engine follows each agent's model, not auth", () => {
  const config = {
    agents: [
      { id: "anth", model: "anthropic/claude-opus-5", tools: {} },
      { id: "oai", model: "openai/gpt-5.5", tools: {} },
    ],
    coordinator: { model: "openai/gpt-5.5" },
    // Auth no longer affects the engine pick; an api-key anthropic entry still
    // routes its anthropic model to the CLI.
    auth: [entry({ mode: "api-key" }), entry({ mode: "oauth", provider: "openai", tokenEnv: "T" })],
  } as unknown as LoadedConfig;
  const map = buildEngineMap(config);
  expect(map.usesOpencode).toBe(true);
  expect(map.usesClaude).toBe(true);
  expect(map.engineOf["anth"]).toBe("claude-code");
  expect(map.engineOf["oai"]).toBe("opencode");
  expect(map.engineOf["coordinator"]).toBe("opencode");
  // cross-cutting/verifier follow agents[0].model (anthropic → claude-code here).
  expect(map.engineOf["cross-cutting"]).toBe("claude-code");
  expect(map.engineOf["verifier"]).toBe("claude-code");
});

test("claudeModelId: strips a leading provider segment; bare ids pass through", () => {
  expect(claudeModelId("anthropic/claude-opus-5")).toBe("claude-opus-5");
  expect(claudeModelId("opus")).toBe("opus");
  expect(claudeModelId("sonnet")).toBe("sonnet");
});

test("claudeModelMatches: dated-suffix family match; cross-family mismatch", () => {
  // A plain fallback within the family (dated actual id) matches the configured id.
  expect(claudeModelMatches("anthropic/claude-haiku-4-5", "claude-haiku-4-5-20251001")).toBe(true);
  expect(claudeModelMatches("claude-haiku-4-5", "claude-haiku-4-5")).toBe(true);
  // A real swap to a different family does NOT match (a substitution to surface).
  expect(claudeModelMatches("anthropic/claude-opus-5", "claude-sonnet-5-20250101")).toBe(false);
});

test("buildClaudeArgs: read-only, trust-isolated, subscription argv; never --bare", () => {
  const args = buildClaudeArgs({
    model: "claude-opus-5",
    system: "SYS",
    cwd: "/work/repo",
    maxTurns: 60,
  });
  const joined = args.join(" ");
  expect(joined).toContain("--output-format json");
  expect(joined).toContain("--model claude-opus-5");
  expect(joined).toContain("--append-system-prompt SYS");
  // Read, Grep, AND Glob are all path-scoped to the review tree — a bare Grep
  // would read arbitrary files (credentials, /proc/self/environ) despite the
  // scoped Read, defeating the whole exfiltration defense.
  expect(joined).toContain(
    "--allowedTools Read(//work/repo/**) Grep(//work/repo/**) Glob(//work/repo/**)",
  );
  expect(joined).not.toContain(" Grep ");
  expect(joined).not.toContain(" Glob ");
  // Write/exec/net tools are denied outright; out-of-tree reads are denied by
  // dontAsk's unmatched-rule denial (NO explicit Read deny: `Read(~/**)` would
  // deny the whole tree whenever the repo lives under the home directory).
  expect(joined).toContain(
    "--disallowedTools Bash Edit Write NotebookEdit NotebookRead WebFetch WebSearch Task TodoWrite BashOutput KillShell ExitPlanMode",
  );
  expect(joined).not.toContain("Read(~");
  expect(joined).toContain("--permission-mode dontAsk");
  expect(joined).toContain("--strict-mcp-config");
  expect(joined).toContain("--safe-mode");
  expect(joined).toContain("--max-turns 60");
  expect(args).toContain("-p");
  expect(args).not.toContain("--bare");
});

test("parseClaudeResult: success maps text/cost/tokens/model", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "the findings",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 30,
    },
    modelUsage: { "claude-opus-5-20250101": { costUSD: 0.0123, outputTokens: 200 } },
  });
  const r = parseClaudeResult(stdout);
  expect(r.isError).toBe(false);
  expect(r.text).toBe("the findings");
  expect(r.cost).toBe(0.0123);
  expect(r.tokens).toEqual({ input: 100, output: 200, cache: { write: 50, read: 30 } });
  expect(r.modelOutputTokens).toEqual({ "claude-opus-5-20250101": 200 });
});

test("pickAnsweringModel: prefers the requested family over key order; else max output", async () => {
  const { pickAnsweringModel } = await import("../core/claude-code.js");
  // The CLI bills its internal helper (haiku) in modelUsage too, often FIRST —
  // key order is meaningless. Family match must win.
  expect(
    pickAnsweringModel("anthropic/claude-sonnet-5", {
      "claude-haiku-4-5-20251001": 40,
      "claude-sonnet-5": 3000,
    }),
  ).toBe("claude-sonnet-5");
  // No family match (real substitution): the dominant output-token key wins.
  expect(
    pickAnsweringModel("anthropic/claude-opus-5", {
      "claude-haiku-4-5-20251001": 40,
      "claude-sonnet-5": 3000,
    }),
  ).toBe("claude-sonnet-5");
  expect(pickAnsweringModel("anthropic/claude-opus-5", {})).toBeUndefined();
});

test("parseClaudeResult: is_error true even when subtype stays 'success'", () => {
  // The documented gotcha: subtype can be "success" on an API error — key off is_error.
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "API Error: 429 rate_limit",
    total_cost_usd: 0,
  });
  const r = parseClaudeResult(stdout);
  expect(r.isError).toBe(true);
  expect(r.errorText).toBe("API Error: 429 rate_limit");
});

test("parseClaudeResult: unparseable stdout is an error, not a throw", () => {
  const r = parseClaudeResult("not json at all");
  expect(r.isError).toBe(true);
  expect(r.errorText).toBe("not json at all");
});

test("classifyClaudeError: rate-limit / auth / usage-limit / other", () => {
  expect(classifyClaudeError("API Error: 429 Too Many Requests")).toBe("rate-limit");
  expect(classifyClaudeError("model overloaded")).toBe("rate-limit");
  expect(classifyClaudeError("oauth_org_not_allowed")).toBe("auth");
  expect(classifyClaudeError("authentication_failed")).toBe("auth");
  expect(classifyClaudeError("Claude AI usage limit reached|1728000000")).toBe("usage-limit");
  expect(classifyClaudeError("something else entirely")).toBe("other");
  // An explicit API status wins over the text.
  expect(classifyClaudeError("whatever", 401)).toBe("auth");
  expect(classifyClaudeError("whatever", 429)).toBe("rate-limit");
});

test("usageLimitResetMs: parses the trailing epoch; null on garbage", () => {
  // 10-digit epoch seconds → ms.
  expect(usageLimitResetMs("usage limit reached|1728000000")).toBe(1728000000_000);
  // 13-digit already-ms passes through.
  expect(usageLimitResetMs("usage limit reached|1728000000000")).toBe(1728000000000);
  expect(usageLimitResetMs("usage limit reached")).toBeNull();
  expect(usageLimitResetMs("usage limit reached|nope")).toBeNull();
});

test("assertClaudeModels: rejects non-anthropic model ids before touching the CLI", async () => {
  const { assertClaudeModels } = await import("../core/claude-code.js");
  const handle = { cliPath: "/nonexistent/claude", childEnv: {} } as never;
  // The foreign-model guard throws before any subprocess spawns, so the bogus
  // cliPath is never executed.
  await expect(
    assertClaudeModels(handle, ["anthropic/claude-opus-5", "openai/gpt-5.4-mini"]),
  ).rejects.toThrow(/only run anthropic\/… models.*openai\/gpt-5\.4-mini/s);
  // Unprefixed ids are left to per-call validation, not rejected here.
  await expect(assertClaudeModels(handle, ["openai-api/gpt-5.5-pro"])).rejects.toThrow(
    /openai-api\/gpt-5\.5-pro/,
  );
});

test("buildClaudeArgs: cross-cutting/verifier get Read+Grep scoped, Glob denied by name", () => {
  const args = buildClaudeArgs({
    model: "claude-opus-5",
    system: "SYS",
    cwd: "/work/repo",
    tools: ["read", "grep"],
  });
  const joined = args.join(" ");
  // Glob is deliberately withheld: an empty allow list default-allows reads, so a
  // withheld read tool must be denied BY NAME, not just left out of --allowedTools.
  expect(joined).toContain("--allowedTools Read(//work/repo/**) Grep(//work/repo/**)");
  expect(joined).not.toContain("Glob(/");
  expect(joined).toContain(
    "--disallowedTools Glob Bash Edit Write NotebookEdit NotebookRead WebFetch WebSearch Task TodoWrite BashOutput KillShell ExitPlanMode",
  );
});

test("buildClaudeArgs: reviewer tools honor the configured read set (list ignored)", () => {
  const args = buildClaudeArgs({
    model: "claude-opus-5",
    system: "SYS",
    cwd: "/work/repo",
    tools: ["read", "grep", "glob", "list"],
  });
  const joined = args.join(" ");
  expect(joined).toContain(
    "--allowedTools Read(//work/repo/**) Grep(//work/repo/**) Glob(//work/repo/**)",
  );
  // `list` has no scoped Claude equivalent and is silently ignored (no crash, no rule).
  expect(joined).not.toContain("List");
  expect(joined).toContain(
    "--disallowedTools Bash Edit Write NotebookEdit NotebookRead WebFetch WebSearch Task TodoWrite BashOutput KillShell ExitPlanMode",
  );
});

test("buildClaudeArgs: empty tools (coordinator/no-tools fallback) deny every read tool", () => {
  const args = buildClaudeArgs({
    model: "claude-opus-5",
    system: "SYS",
    cwd: "/work/repo",
    tools: [],
  });
  const joined = args.join(" ");
  // No --allowedTools at all, and Read/Grep/Glob explicitly denied so dontAsk's
  // default-allow can't grant a read.
  expect(joined).not.toContain("--allowedTools");
  expect(joined).toContain(
    "--disallowedTools Read Grep Glob Bash Edit Write NotebookEdit NotebookRead WebFetch WebSearch Task TodoWrite BashOutput KillShell ExitPlanMode",
  );
});

test("buildClaudeArgs: maxTurns is forwarded as the CLI --max-turns bound", () => {
  const args = buildClaudeArgs({
    model: "claude-opus-5",
    system: "SYS",
    cwd: "/work/repo",
    maxTurns: 50,
  });
  expect(args.join(" ")).toContain("--max-turns 50");
});

test("usageLimitMessage: non-transient so the pass fails fast, carrying the reset time", () => {
  const msg = usageLimitMessage("Claude AI usage limit reached|1728000000");
  // The old wording contained "rate limit" and matched isTransientApiError, burning
  // the 429 backoff schedule on three doomed retries against an hours-away cap.
  expect(isTransientApiError(new Error(msg))).toBe(false);
  expect(msg).toContain(new Date(1728000000_000).toISOString());
  // No reset epoch present → "later", still non-transient.
  expect(isTransientApiError(new Error(usageLimitMessage("usage limit reached")))).toBe(false);
});

test("claudeTokenCredential: resolution order + oat/api-key classification", () => {
  const oat = `sk-ant-oat01-${"x".repeat(95)}`;
  const apiKey = `sk-ant-api03-${"y".repeat(95)}`;
  // A named, set tokenEnv wins; an "sk-ant-oat…" value classifies as oauth
  // (forwarded as CLAUDE_CODE_OAUTH_TOKEN).
  expect(claudeTokenCredential({ tokenEnv: "MY_TOK" }, { MY_TOK: oat })).toEqual({
    value: oat,
    kind: "oauth",
  });
  // An "sk-ant-api…" Console key classifies as api-key (forwarded as ANTHROPIC_API_KEY).
  expect(claudeTokenCredential({ tokenEnv: "MY_TOK" }, { MY_TOK: apiKey })).toEqual({
    value: apiKey,
    kind: "api-key",
  });
  // A named-but-unset tokenEnv falls back to the ambient CLAUDE_CODE_OAUTH_TOKEN
  // (the var `ecr setup-auth` exports and startClaudeCode forwards).
  expect(claudeTokenCredential({ tokenEnv: "MY_TOK" }, { CLAUDE_CODE_OAUTH_TOKEN: oat })).toEqual({
    value: oat,
    kind: "oauth",
  });
  // No entry / no tokenEnv → the ambient token (login/CI fallback).
  expect(claudeTokenCredential({}, { CLAUDE_CODE_OAUTH_TOKEN: oat })).toEqual({
    value: oat,
    kind: "oauth",
  });
  expect(claudeTokenCredential(undefined, { CLAUDE_CODE_OAUTH_TOKEN: apiKey })).toEqual({
    value: apiKey,
    kind: "api-key",
  });
  // Nothing anywhere → undefined (the local `claude` login covers the run).
  expect(claudeTokenCredential({ tokenEnv: "MY_TOK" }, {})).toBeUndefined();
  expect(claudeTokenCredential(undefined, {})).toBeUndefined();
});

test("claudeTemperatureNote: flags non-default temperatures on CLAUDE-ROUTED passes only", () => {
  const config = (agentTemp: number, coordTemp: number): LoadedConfig =>
    ({
      agents: [{ id: "a", temperature: agentTemp }],
      coordinator: { temperature: coordTemp },
    }) as unknown as LoadedConfig;
  const allClaude = { a: "claude-code", coordinator: "claude-code" } as const;
  // Defaults (agents 0.1, coordinator 0) → nothing to say.
  expect(claudeTemperatureNote(config(0.1, 0), allClaude)).toBeNull();
  // A tuned claude-routed agent temperature → a note that it was ignored.
  expect(claudeTemperatureNote(config(0.7, 0), allClaude)).toContain(
    "not supported by the claude-code engine",
  );
  // A tuned claude-routed coordinator temperature → same.
  expect(claudeTemperatureNote(config(0.1, 0.5), allClaude)).toContain("were ignored");
  // Mixed run: the tuned agent is OPENCODE-routed, so its temperature IS honored —
  // no note, even though the (default-temperature) coordinator is claude-routed.
  expect(
    claudeTemperatureNote(config(0.7, 0), { a: "opencode", coordinator: "claude-code" }),
  ).toBeNull();
});

test("pathInside: inside → true; outside/self → false", async () => {
  const { pathInside } = await import("../core/exec.js");
  expect(pathInside("/repo/sub/claude", "/repo")).toBe(true);
  expect(pathInside("/repo", "/repo")).toBe(false);
  expect(pathInside("/usr/local/bin/claude", "/repo")).toBe(false);
  expect(pathInside("/repo/../elsewhere/claude", "/repo")).toBe(false);
});

test("buildClaudeArgs: a Windows backslash cwd is normalized in the tool scopes", () => {
  const args = buildClaudeArgs({
    model: "claude-opus-5",
    system: "SYS",
    cwd: "C:\\Users\\dev\\repo",
  });
  const joined = args.join(" ");
  expect(joined).toContain("Read(/C:/Users/dev/repo/**)");
  expect(joined).not.toContain("\\");
});
