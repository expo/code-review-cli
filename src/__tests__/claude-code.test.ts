import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "bun:test";

import {
  assertClaudeModels,
  buildClaudeArgs,
  buildEngineMap,
  claudeActivities,
  claudeCodePromptAndParse,
  claudeSubscriptionActive,
  claudeTemperatureNote,
  claudeTokenCredential,
  classifyClaudeError,
  createClaudeActivityStream,
  claudeModelId,
  claudeModelMatches,
  engineForModel,
  parseClaudeResult,
  pickAnsweringModel,
  runClaudePrompt,
  startClaudeCode,
  usageLimitMessage,
  usageLimitResetMs,
} from "../core/claude-code.js";
import type { ClaudeCodeHandle } from "../core/claude-code.js";
import {
  AgentTimeoutError,
  CLAUDE_CODE_ENGINE,
  isTransientApiError,
  promptAndParse,
} from "../core/opencode.js";
import type { OpencodeHandle } from "../core/opencode.js";
import { parseReviewerOutput } from "../core/schema.js";
import { RateLimitWatch } from "../core/throttle.js";
import type { AuthConfigEntry, LoadedConfig } from "../config/schema.js";

const entry = (over: Partial<AuthConfigEntry>): AuthConfigEntry => ({
  provider: "anthropic",
  mode: "api-key",
  ...over,
});

/**
 * Write an executable fake `claude` CLI to a fresh temp dir and return its path.
 * Real-subprocess style (matching exec.test.ts) rather than mocking child_process,
 * so runClaudePrompt/assertClaudeModels/startClaudeCode exercise the real `run()`
 * spawn/execFile paths against it.
 */
async function fakeClaude(script: string): Promise<{ bin: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-claude-code-test-"));
  const bin = path.join(dir, "claude");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return { bin, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A fake `claude` that returns a different canned final-result body on
 * each successive invocation (tracked via a counter file, since childEnv is fixed
 * for the whole test) and logs each call's stdin (the prompt actually sent) to
 * `<dir>/stdin.<n>` via `stdinLog(n)` — so a corrective-retry test can assert what
 * the SECOND call sent, not just that a second call happened. The last output
 * repeats for any call beyond `outputs.length`.
 */
async function sequencedFakeClaude(outputs: string[]): Promise<{
  bin: string;
  stdinLog: (n: number) => Promise<string>;
  argsLog: (n: number) => Promise<string>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-claude-code-test-"));
  const bin = path.join(dir, "claude");
  const counterFile = path.join(dir, "count");
  for (const [i, out] of outputs.entries()) {
    await writeFile(path.join(dir, `out.${i + 1}`), out, "utf8");
  }
  const script = [
    "#!/bin/sh",
    `COUNT_FILE="${counterFile}"`,
    "COUNT=0",
    '[ -f "$COUNT_FILE" ] && COUNT=$(cat "$COUNT_FILE")',
    "COUNT=$((COUNT + 1))",
    'echo "$COUNT" > "$COUNT_FILE"',
    `cat > "${dir}/stdin.$COUNT"`,
    `printf '%s\n' "$@" > "${dir}/args.$COUNT"`,
    `if [ "$COUNT" -gt ${outputs.length} ]; then COUNT=${outputs.length}; fi`,
    `cat "${dir}/out.$COUNT"`,
    "",
  ].join("\n");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return {
    bin,
    stdinLog: (n: number) => readFile(path.join(dir, `stdin.${n}`), "utf8"),
    argsLog: (n: number) => readFile(path.join(dir, `args.${n}`), "utf8"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * A ClaudeCodeHandle for tests that call runClaudePrompt/claudeCodePromptAndParse/
 * assertClaudeModels directly, without going through startClaudeCode. A fresh,
 * never-written-to rate-limit log path keeps handle.rateLimit.events at 0 until a
 * test's own note()/check() call moves it.
 */
function testHandle(cliPath: string, over: Partial<ClaudeCodeHandle> = {}): ClaudeCodeHandle {
  return {
    client: undefined,
    url: "",
    close: () => {},
    rateLimit: new RateLimitWatch(
      path.join(tmpdir(), `ecr-claude-code-test-norate-${process.pid}-${Math.random()}.log`),
    ),
    engine: CLAUDE_CODE_ENGINE,
    models: { reviewer: "anthropic/claude-opus-5" },
    tools: { reviewer: ["read", "grep", "glob"] },
    defaultModel: "anthropic/claude-opus-5",
    cliPath,
    childEnv: { PATH: process.env.PATH ?? "" },
    ...over,
  };
}

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
  // The v2 stack verifier is registered like the verifier (shared default model), so a
  // claude-routed run has a handle for it instead of crashing on an undefined agent id.
  expect(map.modelOf["stack-verifier"]).toBe("anthropic/claude-opus-5");
  expect(map.engineOf["stack-verifier"]).toBe("claude-code");
});

test("buildEngineMap: a selected subset scopes the engine set to the passes that run", () => {
  const config = {
    agents: [
      { id: "oai", model: "openai/gpt-5.5", tools: {} },
      { id: "anth", model: "anthropic/claude-opus-5", tools: {} },
    ],
    coordinator: { model: "openai/gpt-5.5" },
    auth: [],
  } as unknown as LoadedConfig;
  // The full roster drives both engines.
  expect(buildEngineMap(config).usesClaude).toBe(true);
  // Selecting only the OpenCode agent (agents[0], and the coordinator, are OpenCode)
  // means no pass touches Claude — usesClaude is false, so a `--agents oai` run never
  // starts (and can't fail on a missing CLI/token for) the Claude Code engine.
  const openaiOnly = buildEngineMap(config, [config.agents[0]!]);
  expect(openaiOnly.usesClaude).toBe(false);
  expect(openaiOnly.usesOpencode).toBe(true);
  expect(openaiOnly.engineOf["anth"]).toBeUndefined(); // not selected → not dispatchable
  // Selecting only the anthropic agent needs the Claude engine.
  expect(buildEngineMap(config, [config.agents[1]!]).usesClaude).toBe(true);
});

test("buildEngineMap: the always-run verifier/cross-cutting keep the full roster's default model", () => {
  // agents[0] is anthropic (the verifier/cross-cutting default model), the coordinator
  // is OpenCode. Even selecting ONLY the OpenCode agent still runs the verifier on
  // agents[0], so Claude is genuinely required and must not be dropped here.
  const config = {
    agents: [
      { id: "anth", model: "anthropic/claude-opus-5", tools: {} },
      { id: "oai", model: "openai/gpt-5.5", tools: {} },
    ],
    coordinator: { model: "openai/gpt-5.5" },
    auth: [],
  } as unknown as LoadedConfig;
  const map = buildEngineMap(config, [config.agents[1]!]); // select the OpenCode agent
  expect(map.usesClaude).toBe(true);
  expect(map.engineOf["verifier"]).toBe("claude-code");
  expect(map.engineOf["cross-cutting"]).toBe("claude-code");
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
  const jsonSchema = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  };
  const args = buildClaudeArgs({
    model: "claude-opus-5",
    system: "SYS",
    cwd: "/work/repo",
    maxTurns: 60,
    jsonSchema,
  });
  const joined = args.join(" ");
  expect(joined).toContain("--output-format stream-json --verbose");
  expect(joined).toContain("--model claude-opus-5");
  expect(joined).toContain("--append-system-prompt SYS");
  const schemaIndex = args.indexOf("--json-schema");
  expect(schemaIndex).toBeGreaterThan(-1);
  expect(JSON.parse(args[schemaIndex + 1]!)).toEqual(jsonSchema);
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
  expect(r.hasStructuredOutput).toBe(false);
  expect(r.structuredOutputFailure).toBe(false);
});

test("parseClaudeResult: reads the final result from stream-json JSONL", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "the findings",
      total_cost_usd: 0.02,
      usage: { input_tokens: 12, output_tokens: 34 },
    }),
  ].join("\n");
  const result = parseClaudeResult(stdout);
  expect(result.isError).toBe(false);
  expect(result.text).toBe("the findings");
  expect(result.cost).toBe(0.02);
  expect(result.tokens).toEqual({
    input: 12,
    output: 34,
    cache: { write: undefined, read: undefined },
  });
});

test("parseClaudeResult: prefers provider-validated structured_output", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    // Keep a conflicting text result to prove the structured object wins.
    result: '{"title":"wrong"}',
    structured_output: { title: "validated" },
  });
  const result = parseClaudeResult(stdout);
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.text)).toEqual({ title: "validated" });
  expect(result.hasStructuredOutput).toBe(true);
});

test("parseClaudeResult: an error ignores stale structured_output", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    result: "Could not produce valid structured output",
    structured_output: { title: "PR_SECRET rate limit" },
  });
  const result = parseClaudeResult(stdout);
  expect(result.isError).toBe(true);
  expect(result.errorText).toBe("Could not produce valid structured output");
  expect(result.errorText).not.toContain("PR_SECRET");
  expect(result.structuredOutputFailure).toBe(true);
});

test("claudeActivities: reports lifecycle and safe tool targets, never raw text/results/patterns", () => {
  expect(
    claudeActivities({ type: "system", subtype: "init", model: "claude-opus-5" }, "/repo"),
  ).toEqual([{ line: "started claude-opus-5" }]);
  expect(
    claudeActivities(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "secret reasoning" },
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { file_path: "/repo/src/auth.ts" },
            },
            {
              type: "tool_use",
              id: "grep-1",
              name: "Grep",
              input: { path: "/repo/src", pattern: "DO_NOT_LOG_THIS" },
            },
            {
              type: "tool_use",
              id: "outside-1",
              name: "Read",
              input: { file_path: "/etc/passwd\nforged log line" },
            },
            {
              type: "tool_use",
              id: "glob-1",
              name: "Glob",
              input: { pattern: "SECRET_PATTERN" },
            },
          ],
        },
      },
      "/repo",
    ),
  ).toEqual([
    { key: "read-1", line: "Read src/auth.ts" },
    { key: "grep-1", line: "Grep src" },
    { key: "outside-1", line: "Read" },
    { key: "glob-1", line: "Glob" },
  ]);
  expect(
    claudeActivities(
      { type: "result", is_error: false, duration_ms: 12_400, num_turns: 3 },
      "/repo",
    ),
  ).toEqual([{ line: "completed (12s, 3 turn(s))" }]);
  expect(
    claudeActivities(
      { type: "user", message: { content: [{ type: "tool_result", content: "SECRET" }] } },
      "/repo",
    ),
  ).toEqual([]);
});

test("createClaudeActivityStream: handles chunk boundaries and dedupes repeated tool ids", () => {
  const lines: string[] = [];
  const stream = createClaudeActivityStream("/repo", (line) => lines.push(line));
  const init = `${JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" })}\n`;
  const tool = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/repo/a.ts" } },
      ],
    },
  });
  stream.push(init.slice(0, 15));
  stream.push(`${init.slice(15)}${tool}\n${tool.slice(0, 20)}`);
  stream.push(tool.slice(20));
  stream.finish();
  expect(lines).toEqual(["started claude-opus-5", "Read a.ts"]);
});

test("pickAnsweringModel: prefers the requested family over key order; else max output", () => {
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
  expect(r.errorText).toBe("Claude Code stream ended without a final result event");
});

test("parseClaudeResult: a stream without a final result does not expose its transcript", () => {
  const secret = "PR_SECRET rate limit";
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: secret }] },
    }),
  ].join("\n");
  const result = parseClaudeResult(stdout);
  expect(result.isError).toBe(true);
  expect(result.errorText).toBe("Claude Code stream ended without a final result event");
  expect(result.errorText).not.toContain(secret);
});

test("parseClaudeResult: an error result without a message does not expose its transcript", () => {
  const secret = "PR_SECRET quota";
  const stdout = [
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: secret }] },
    }),
    JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "" }),
  ].join("\n");
  const result = parseClaudeResult(stdout);
  expect(result.isError).toBe(true);
  expect(result.errorText).toBe("Claude Code returned an error without a message");
  expect(result.errorText).not.toContain(secret);
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

test("claudeSubscriptionActive: probes the resolved path from tmpdir with the given env, never bare `claude`", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-claude-sub-"));
  const bin = path.join(dir, "claude");
  const probe = path.join(dir, "probe");
  // Record how it was invoked ($0), from where (pwd), and the env var it received,
  // then report an active Max login.
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s' "$0" > "${probe}.argv0"
pwd > "${probe}.cwd"
printf '%s' "$ECR_PROBE_ENV" > "${probe}.env"
echo "Logged in to a Max subscription"
exit 0
`,
    "utf8",
  );
  await chmod(bin, 0o755);
  try {
    const active = await claudeSubscriptionActive({
      cliPath: bin,
      env: { PATH: process.env.PATH ?? "", ECR_PROBE_ENV: "sentinel" },
    });
    expect(active).toBe(true);
    // The resolved absolute path was spawned, not a bare "claude".
    expect(await readFile(`${probe}.argv0`, "utf8")).toBe(bin);
    // From tmpdir(), never the inherited (possibly untrusted) cwd.
    expect(await realpath((await readFile(`${probe}.cwd`, "utf8")).trim())).toBe(
      await realpath(tmpdir()),
    );
    // The caller's allowlisted env reached the child (and nothing else — it replaces
    // process.env), so ambient secrets never leak into the probe.
    expect(await readFile(`${probe}.env`, "utf8")).toBe("sentinel");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claudeSubscriptionActive: refuses (never runs) an in-tree `claude` when resolving internally", async () => {
  // realpath so the dir has no /var→/private/var symlink to defeat the in-tree check.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ecr-claude-intree-")));
  const bin = path.join(dir, "claude");
  const ran = path.join(dir, "ran");
  await writeFile(bin, `#!/bin/sh\ntouch "${ran}"\necho "logged in"\nexit 0\n`, "utf8");
  await chmod(bin, 0o755);
  const savedPath = process.env.PATH;
  const savedCwd = process.cwd();
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
  process.chdir(dir); // cwd now CONTAINS the fake claude → in-tree
  try {
    // Internal resolution: resolveOnPath finds dir/claude, pathInside refuses it, so
    // the probe returns false WITHOUT executing the PR-committed binary.
    expect(await claudeSubscriptionActive()).toBe(false);
    expect(existsSync(ran)).toBe(false);
  } finally {
    process.chdir(savedCwd);
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
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

test("startClaudeCode: childEnv is an allowlist (forbidden ambient secrets excluded) and forwards the resolved credential", async () => {
  const { bin, cleanup } = await fakeClaude("#!/bin/sh\nexit 0\n");
  const dir = path.dirname(bin);
  const saved = {
    PATH: process.env.PATH,
    GH_TOKEN: process.env.GH_TOKEN,
    TERM: process.env.TERM,
    ECR_TEST_TOKEN: process.env.ECR_TEST_TOKEN,
  };
  process.env.PATH = `${dir}${path.delimiter}${saved.PATH}`;
  // A forbidden ambient secret (per FORBIDDEN_TOKEN_ENVS/auth.ts) that must never
  // reach the untrusted-PR-content-processing child, alongside an allowlisted var
  // that must still be forwarded.
  process.env.GH_TOKEN = "leaked-secret";
  process.env.TERM = "xterm-256color";
  const oat = `sk-ant-oat01-${"x".repeat(95)}`;
  process.env.ECR_TEST_TOKEN = oat;
  try {
    const config = {
      agents: [{ id: "reviewer", model: "anthropic/claude-opus-5", tools: {} }],
      coordinator: { model: "anthropic/claude-opus-5" },
      auth: [entry({ tokenEnv: "ECR_TEST_TOKEN" })],
    } as unknown as LoadedConfig;
    const handle = await startClaudeCode(config);
    expect(handle.childEnv.TERM).toBe("xterm-256color");
    expect(handle.childEnv.GH_TOKEN).toBeUndefined();
    // sk-ant-oat… classifies as oauth ⇒ CLAUDE_CODE_OAUTH_TOKEN, never ANTHROPIC_API_KEY.
    expect(handle.childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(oat);
    expect(handle.childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanup();
  }
});

test("startClaudeCode: no credential anywhere and no local `claude` login rejects fail-fast", async () => {
  const { bin, cleanup } = await fakeClaude(
    '#!/bin/sh\nif [ "$1" = "auth" ]; then\n  echo "not logged in"\n  exit 1\nfi\nexit 0\n',
  );
  const dir = path.dirname(bin);
  const saved = {
    PATH: process.env.PATH,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.PATH = `${dir}${path.delimiter}${saved.PATH}`;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const config = {
      agents: [{ id: "reviewer", model: "anthropic/claude-opus-5", tools: {} }],
      coordinator: { model: "anthropic/claude-opus-5" },
      auth: [] as AuthConfigEntry[],
    } as unknown as LoadedConfig;
    await expect(startClaudeCode(config)).rejects.toThrow(/No Claude credential found/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanup();
  }
});

test("assertClaudeModels: the CLI-presence check succeeds when `claude --version` exits 0", async () => {
  const { bin, cleanup } = await fakeClaude("#!/bin/sh\nexit 0\n");
  try {
    await expect(
      assertClaudeModels(testHandle(bin), ["anthropic/claude-opus-5"]),
    ).resolves.toBeUndefined();
  } finally {
    await cleanup();
  }
});

test("assertClaudeModels: a failing `claude --version` reports the missing-CLI install message", async () => {
  const { bin, cleanup } = await fakeClaude("#!/bin/sh\nexit 1\n");
  try {
    await expect(assertClaudeModels(testHandle(bin), ["anthropic/claude-opus-5"])).rejects.toThrow(
      /claude` CLI is not installed/,
    );
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: our own deadline kills the child and throws AgentTimeoutError('time')", async () => {
  const { bin, cleanup } = await fakeClaude("#!/bin/sh\ncat > /dev/null\nsleep 5\n");
  try {
    let caught: unknown;
    try {
      await runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
        maxWaitMs: 300,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentTimeoutError);
    expect((caught as AgentTimeoutError).reason).toBe("time");
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: a non-timeout signal names the signal without exposing stderr", async () => {
  const secret = "PR_SECRET from stderr";
  const { bin, cleanup } = await fakeClaude(
    `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${secret}' >&2\nkill -9 $$\n`,
  );
  try {
    let message = "";
    try {
      await runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("killed by signal SIGKILL");
    expect(message).not.toContain(secret);
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: oversized child output surfaces the 64MB buffer message, not a parse failure", async () => {
  const { bin, cleanup } = await fakeClaude(
    "#!/bin/sh\ncat > /dev/null\nyes x | head -c 70000000\n",
  );
  try {
    await expect(
      runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      }),
    ).rejects.toThrow(/64MB buffer/);
  } finally {
    await cleanup();
  }
}, 20_000);

test("runClaudePrompt: a 429 result dispatches to a rate-limit throw and records rateLimit evidence", async () => {
  const body = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "API Error: 429 Too Many Requests",
    total_cost_usd: 0,
  });
  const { bin, cleanup } = await fakeClaude(`#!/bin/sh\ncat > /dev/null\nprintf '%s' '${body}'\n`);
  try {
    const handle = testHandle(bin);
    expect(handle.rateLimit.events).toBe(0);
    await expect(
      runClaudePrompt(handle, { agent: "reviewer", system: "SYS", text: "hi", title: "t" }),
    ).rejects.toThrow(/rate limit hit/);
    // handle.rateLimit.note() ran: this engine has no OpenCode log to scan, so
    // runClaudePrompt is the only place rate-limit evidence gets recorded.
    expect(handle.rateLimit.events).toBe(1);
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: an incomplete stream cannot forge rate-limit evidence or leak tool results", async () => {
  const secret = "PR_SECRET rate limit quota usage limit reached|1728000000";
  const body = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: secret }] },
    }),
  ].join("\n");
  const { bin, cleanup } = await fakeClaude(`#!/bin/sh\ncat > /dev/null\nprintf '%s' '${body}'\n`);
  try {
    const handle = testHandle(bin);
    let message = "";
    try {
      await runClaudePrompt(handle, {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("stream ended without a final result event");
    expect(message).toContain("Claude Code exited with code 0");
    expect(message).not.toContain(secret);
    expect(handle.rateLimit.events).toBe(0);
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: an early bad-flag failure reports a safe fixed diagnostic", async () => {
  const secret = "PR_SECRET from stderr";
  const { bin, cleanup } = await fakeClaude(
    `#!/bin/sh\ncat > /dev/null\nprintf '%s' "error: unknown option '--json-schema' ${secret}" >&2\nexit 2\n`,
  );
  try {
    let message = "";
    try {
      await runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Claude Code exited with code 2");
    expect(message).toContain("CLI rejected its arguments");
    expect(message).toContain("verify the pinned @anthropic-ai/claude-code version");
    expect(message).not.toContain("--json-schema");
    expect(message).not.toContain(secret);
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: an early auth failure names the fix without copying stderr", async () => {
  const secret = "PR_SECRET from auth stderr";
  const { bin, cleanup } = await fakeClaude(
    `#!/bin/sh\ncat > /dev/null\nprintf '%s' 'OAuth authentication failed: ${secret}' >&2\nexit 1\n`,
  );
  try {
    let message = "";
    try {
      await runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Claude Code exited with code 1");
    expect(message).toContain("authentication failed before a result was emitted");
    expect(message).toContain("`claude auth status` and `ecr doctor`");
    expect(message).not.toContain(secret);
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: unknown early stderr is never copied into the failure", async () => {
  const secret = "PR_SECRET arbitrary diagnostic";
  const { bin, cleanup } = await fakeClaude(
    `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${secret}' >&2\nexit 7\n`,
  );
  try {
    let message = "";
    try {
      await runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Claude Code exited with code 7");
    expect(message).not.toContain(secret);
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: a usage-limit result throws the non-retryable, reset-time-carrying message", async () => {
  const body = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Claude AI usage limit reached|1728000000",
    total_cost_usd: 0,
  });
  const { bin, cleanup } = await fakeClaude(`#!/bin/sh\ncat > /dev/null\nprintf '%s' '${body}'\n`);
  try {
    await expect(
      runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      }),
    ).rejects.toThrow(/usage limit reached; resets/);
  } finally {
    await cleanup();
  }
});

test("runClaudePrompt: streams safe tool activity while preserving the final result", async () => {
  const body = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: process.cwd() + "/src/core/auth.ts" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "the findings",
      duration_ms: 2500,
      num_turns: 2,
      total_cost_usd: 0.01,
    }),
  ].join("\n");
  const { bin, cleanup } = await fakeClaude(`#!/bin/sh\ncat > /dev/null\nprintf '%s' '${body}'\n`);
  try {
    const activity: string[] = [];
    const result = await runClaudePrompt(testHandle(bin), {
      agent: "reviewer",
      system: "SYS",
      text: "hi",
      title: "t",
      onActivity: (line) => activity.push(line),
    });
    expect(result.text).toBe("the findings");
    expect(activity).toEqual([
      "started claude-opus-5",
      "Read src/core/auth.ts",
      "completed (3s, 2 turn(s))",
    ]);
  } finally {
    await cleanup();
  }
});

test("claudeCodePromptAndParse: a parseable first reply returns immediately with truncated:false", async () => {
  const body = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ ok: true }),
    total_cost_usd: 0.02,
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  const { bin, cleanup } = await sequencedFakeClaude([body]);
  try {
    const out = await claudeCodePromptAndParse(
      testHandle(bin),
      { agent: "reviewer", system: "SYS", text: "hi", title: "t" },
      (text) => JSON.parse(text) as { ok: boolean },
    );
    expect(out.value).toEqual({ ok: true });
    expect(out.truncated).toBe(false);
    expect(out.cost).toBe(0.02);
    expect(out.tokens).toEqual({
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
  } finally {
    await cleanup();
  }
});

test("promptAndParse: a Claude-routed production parser forwards its JSON Schema", async () => {
  const body = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"findings":[]}',
    structured_output: { findings: [] },
  });
  const { bin, argsLog, cleanup } = await sequencedFakeClaude([body]);
  try {
    const output = await promptAndParse(
      testHandle(bin) as unknown as OpencodeHandle,
      { agent: "reviewer", system: "SYS", text: "hi", title: "t" },
      parseReviewerOutput,
    );
    expect(output.value).toEqual({ findings: [] });

    const args = (await argsLog(1)).split("\n");
    const schemaIndex = args.indexOf("--json-schema");
    expect(schemaIndex).toBeGreaterThan(-1);
    const schema = JSON.parse(args[schemaIndex + 1]!) as {
      properties: { findings: { items: { required: string[] } } };
    };
    expect(schema.properties.findings.items.required).toContain("title");
  } finally {
    await cleanup();
  }
});

test("promptAndParse: Claude structured-output exhaustion retries once and preserves usage", async () => {
  const exhausted = JSON.stringify({
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    result: "Could not produce valid structured output",
    total_cost_usd: 0.01,
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  const recovered = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ignored in structured mode",
    structured_output: { findings: [] },
    total_cost_usd: 0.03,
    usage: { input_tokens: 11, output_tokens: 13 },
  });
  const { bin, stdinLog, cleanup } = await sequencedFakeClaude([exhausted, recovered]);
  try {
    const activity: string[] = [];
    const output = await promptAndParse(
      testHandle(bin) as unknown as OpencodeHandle,
      {
        agent: "security",
        system: "SYS",
        text: "review",
        title: "security review",
        onActivity: (line) => activity.push(line),
      },
      parseReviewerOutput,
    );
    expect(output.value).toEqual({ findings: [] });
    expect(output.cost).toBeCloseTo(0.04);
    expect(output.tokens).toEqual({
      input: 16,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    expect(activity).toContain("structured output validation failed — retrying once");
    expect(await stdinLog(2)).toContain("IMPORTANT: reply with ONLY the single JSON object");
  } finally {
    await cleanup();
  }
});

test("claudeCodePromptAndParse: schema mode never accepts result text without structured_output", async () => {
  const unvalidated = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ ok: "unvalidated" }),
  });
  const validated = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ ok: "wrong-channel" }),
    structured_output: { ok: "validated" },
  });
  const { bin, cleanup } = await sequencedFakeClaude([unvalidated, validated]);
  try {
    const output = await claudeCodePromptAndParse(
      testHandle(bin),
      {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "string" } },
          required: ["ok"],
        },
      },
      (text) => JSON.parse(text) as { ok: string },
    );
    expect(output.value).toEqual({ ok: "validated" });
  } finally {
    await cleanup();
  }
});

test("claudeCodePromptAndParse: repeated structured-output exhaustion fails explicitly", async () => {
  const exhausted = JSON.stringify({
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    result: "Could not produce valid structured output",
  });
  const { bin, cleanup } = await sequencedFakeClaude([exhausted, exhausted]);
  try {
    await expect(
      claudeCodePromptAndParse(
        testHandle(bin),
        {
          agent: "security",
          system: "SYS",
          text: "review",
          title: "security review",
          jsonSchema: { type: "object", required: ["findings"] },
        },
        parseReviewerOutput,
      ),
    ).rejects.toThrow(/could not satisfy its required JSON Schema after retries/);
  } finally {
    await cleanup();
  }
});

test("claudeCodePromptAndParse: an unparseable first reply retries with CLAUDE_CORRECTIVE appended, accumulating cost/tokens across both calls", async () => {
  const bad = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "not json",
    total_cost_usd: 0.01,
    usage: { input_tokens: 5, output_tokens: 5 },
  });
  const good = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ ok: true }),
    total_cost_usd: 0.03,
    usage: { input_tokens: 7, output_tokens: 9 },
  });
  const { bin, stdinLog, cleanup } = await sequencedFakeClaude([bad, good]);
  try {
    const out = await claudeCodePromptAndParse(
      testHandle(bin),
      { agent: "reviewer", system: "SYS", text: "hi", title: "t" },
      (text) => JSON.parse(text) as { ok: boolean },
    );
    expect(out.value).toEqual({ ok: true });
    expect(out.truncated).toBe(false);
    expect(out.cost).toBeCloseTo(0.04);
    expect(out.tokens).toEqual({
      input: 12,
      output: 14,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    const secondPrompt = await stdinLog(2);
    expect(secondPrompt).toContain("IMPORTANT: reply with ONLY the single JSON object");
  } finally {
    await cleanup();
  }
});

test("claudeCodePromptAndParse: both attempts unparseable throws naming both failures", async () => {
  const bad1 = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "still not json",
    total_cost_usd: 0.01,
  });
  const bad2 = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "also not json",
    total_cost_usd: 0.01,
  });
  const { bin, cleanup } = await sequencedFakeClaude([bad1, bad2]);
  try {
    await expect(
      claudeCodePromptAndParse(
        testHandle(bin),
        { agent: "reviewer", system: "SYS", text: "hi", title: "t" },
        (text) => JSON.parse(text) as unknown,
      ),
    ).rejects.toThrow(/did not return parseable JSON after retries/);
  } finally {
    await cleanup();
  }
});
