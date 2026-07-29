import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "bun:test";

import {
  assertClaudeModels,
  buildClaudeArgs,
  buildEngineMap,
  claudeCodePromptAndParse,
  claudeTemperatureNote,
  claudeTokenCredential,
  classifyClaudeError,
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
import { AgentTimeoutError, CLAUDE_CODE_ENGINE, isTransientApiError } from "../core/opencode.js";
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
 * A fake `claude` that returns a different canned `--output-format json` body on
 * each successive invocation (tracked via a counter file, since childEnv is fixed
 * for the whole test) and logs each call's stdin (the prompt actually sent) to
 * `<dir>/stdin.<n>` via `stdinLog(n)` — so a corrective-retry test can assert what
 * the SECOND call sent, not just that a second call happened. The last output
 * repeats for any call beyond `outputs.length`.
 */
async function sequencedFakeClaude(outputs: string[]): Promise<{
  bin: string;
  stdinLog: (n: number) => Promise<string>;
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
    `if [ "$COUNT" -gt ${outputs.length} ]; then COUNT=${outputs.length}; fi`,
    `cat "${dir}/out.$COUNT"`,
    "",
  ].join("\n");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return {
    bin,
    stdinLog: (n: number) => readFile(path.join(dir, `stdin.${n}`), "utf8"),
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

test("runClaudePrompt: a non-timeout signal throws a crash error naming the signal", async () => {
  const { bin, cleanup } = await fakeClaude("#!/bin/sh\ncat > /dev/null\nkill -9 $$\n");
  try {
    await expect(
      runClaudePrompt(testHandle(bin), {
        agent: "reviewer",
        system: "SYS",
        text: "hi",
        title: "t",
      }),
    ).rejects.toThrow(/killed by signal SIGKILL/);
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
