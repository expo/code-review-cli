import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { run } from "../core/exec.js";
import { resolveOpencodeCli } from "../core/opencode.js";
import {
  assertReadableExport,
  buildClaudeSessionExport,
  buildSessionIndex,
  createSessionCapture,
  defaultSessionPass,
  opencodeChildEnv,
  parseSessionIndex,
  pinnedOpencodeVersion,
  publishSessionArchive,
  recordedShaBlocksAttach,
  releasesForHead,
  sessionIdOf,
  sessionTagPrefix,
  SESSION_ZIP_LIMIT_BYTES,
  unzipEntries,
  zipEntries,
  zipTooLarge,
} from "../core/session-archive.js";
import type { SessionIndexPass } from "../core/session-archive.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

interface ExportedMessage {
  info: { role: string; cost?: number };
  parts: { text?: string; tool?: string }[];
}

function messagesOf(json: string): ExportedMessage[] {
  return (JSON.parse(json) as { messages: ExportedMessage[] }).messages;
}

/** Stream lines for `count` assistant turns. Each turn says `step-N`, then reads a file. */
function claudeSteps(count: number): string[] {
  const lines: string[] = [];
  for (let step = 1; step <= count; step++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: `step-${step}` },
            { type: "tool_use", id: `toolu_step_${step}`, name: "Read", input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: `toolu_step_${step}`, content: `body-${step}` },
          ],
        },
      }),
    );
  }
  return lines;
}

function pass(agent: string): SessionIndexPass {
  return {
    agent,
    title: `review-${agent}-c0`,
    sessionId: `ses_${agent}`,
    file: `opencode/${agent}.json`,
    source: "opencode",
  };
}

describe("Session archive", () => {
  test("should open the first reviewer pass", () => {
    const chosen = defaultSessionPass([
      pass("coordinator"),
      pass("verifier"),
      pass("correctness"),
      pass("security"),
    ]);
    expect(chosen?.agent).toBe("correctness");
  });

  test("should stop when the checkout commit differs from the recorded sha", () => {
    expect(recordedShaBlocksAttach(SHA_A, SHA_B)).toBe(true);
    expect(recordedShaBlocksAttach(SHA_A, SHA_A.toUpperCase())).toBe(false);
  });

  test("should refuse an export from a different opencode version", () => {
    expect(() =>
      assertReadableExport(JSON.stringify({ info: { id: "ses_old", version: "9.9.9" } })),
    ).toThrow(/cannot read it/);
    expect(() =>
      assertReadableExport(
        JSON.stringify({ info: { id: "ses_ok", version: pinnedOpencodeVersion() } }),
      ),
    ).not.toThrow();
  });

  test("should put the newest upload for a head first", () => {
    const prefix = sessionTagPrefix("expo/expo", 7, SHA_A);
    const other = sessionTagPrefix("expo/expo", 7, SHA_B);
    const matches = releasesForHead(
      [
        { tag: `${prefix}100`, publishedAt: "2026-01-01T10:00:00Z" },
        { tag: `${prefix}100-2`, publishedAt: "2026-01-01T12:00:00Z" },
        { tag: `${other}300`, publishedAt: "2026-01-01T13:00:00Z" },
        { tag: `${prefix}200`, publishedAt: "2026-01-01T11:00:00Z" },
      ],
      prefix,
    );
    expect(matches.map((release) => release.tag)).toEqual([
      `${prefix}100-2`,
      `${prefix}200`,
      `${prefix}100`,
    ]);
  });

  test("should refuse a repository name that git cannot put in a tag", () => {
    expect(sessionTagPrefix("expo/expo.dev", 7, SHA_A)).toBe(
      `session/expo/expo.dev/7/${SHA_A.slice(0, 12)}/`,
    );
    for (const repo of ["expo/.github", "expo/app.lock", "expo/a..b", ".expo/app"]) {
      expect(() => sessionTagPrefix(repo, 7, SHA_A)).toThrow(/A git tag cannot contain/);
    }
  });

  test("should say why a repository with such a name is not uploaded", async () => {
    const capture = createSessionCapture();
    capture.note({
      agent: "correctness",
      title: "review-correctness-c0",
      source: "claude",
      sessionId: "ses_claude",
      exportJson: "{}",
    });
    const log: string[] = [];
    const store = process.env.SESSION_STORE_REPO;
    // `gh` refuses this store name before it uses the network.
    process.env.SESSION_STORE_REPO = "not-a-store";
    try {
      await publishSessionArchive({
        capture,
        repo: "expo/.github",
        pr: 7,
        headSha: SHA_A,
        log: (line) => log.push(line),
      });
    } finally {
      if (store === undefined) {
        delete process.env.SESSION_STORE_REPO;
      } else {
        process.env.SESSION_STORE_REPO = store;
      }
    }
    expect(log).toEqual([
      'session store: upload failed: No session can be stored for expo/.github. A git tag cannot contain ".github".',
    ]);
  });

  test("should treat an archive over 80 MB as too large", () => {
    expect(zipTooLarge(SESSION_ZIP_LIMIT_BYTES)).toBe(false);
    expect(zipTooLarge(SESSION_ZIP_LIMIT_BYTES + 1)).toBe(true);
  });

  test("should skip the router and keep reviewer order", () => {
    const capture = createSessionCapture();
    capture.preferReviewerOrder(["correctness", "security"]);
    capture.note({
      agent: "coordinator",
      title: "route",
      source: "opencode",
      sessionId: "ses_route",
    });
    capture.note({
      agent: "coordinator",
      title: "review-coordinator",
      source: "opencode",
      sessionId: "ses_coord",
    });
    capture.note({
      agent: "security",
      title: "review-security-c0",
      source: "claude",
      sessionId: "ses_sec",
      exportJson: "{}",
    });
    capture.note({
      agent: "correctness",
      title: "review-correctness-c0",
      source: "claude",
      sessionId: "ses_ok",
      exportJson: "{}",
    });
    expect(capture.count).toBe(3);
    expect(capture.orderedPasses().map((item) => item.sessionId)).toEqual([
      "ses_ok",
      "ses_sec",
      "ses_coord",
    ]);
  });

  test("should read back the entries of an archive", () => {
    const zip = zipEntries([
      { name: "index.json", data: Buffer.from("{}") },
      { name: "opencode/correctness.json", data: Buffer.from("x".repeat(4096)) },
    ]);
    const entries = unzipEntries(zip);
    expect([...entries.keys()]).toEqual(["index.json", "opencode/correctness.json"]);
    expect(entries.get("opencode/correctness.json")?.().toString()).toBe("x".repeat(4096));
  });

  test("should refuse an entry that unpacks past the limit", () => {
    const zip = zipEntries([
      { name: "index.json", data: Buffer.from("{}") },
      { name: "opencode/correctness.json", data: Buffer.from("x".repeat(4096)) },
    ]);
    const entries = unzipEntries(zip, 1024);
    expect(entries.get("index.json")?.().toString()).toBe("{}");
    expect(() => entries.get("opencode/correctness.json")?.()).toThrow(/too large to unpack/);
  });

  test("should refuse an archive entry outside the layout", () => {
    const zip = zipEntries([{ name: "../outside.json", data: Buffer.from("{}") }]);
    expect(() => unzipEntries(zip)).toThrow(/unexpected file/);
  });

  test("should refuse an index with a field attach cannot trust", () => {
    const index = {
      repo: "expo/expo",
      pullRequest: 1,
      headSha: SHA_A,
      createdAt: "2026-01-01T00:00:00.000Z",
      cliVersion: "1.0.0",
      opencodeVersion: pinnedOpencodeVersion(),
      passes: [pass("correctness")],
    };
    expect(parseSessionIndex(JSON.stringify(index)).passes[0]?.agent).toBe("correctness");
    const badSession = { ...index, passes: [{ ...pass("correctness"), sessionId: "--help" }] };
    expect(() => parseSessionIndex(JSON.stringify(badSession))).toThrow(/passes.0.sessionId/);
    const badFile = { ...index, passes: [{ ...pass("correctness"), file: "../session.json" }] };
    expect(() => parseSessionIndex(JSON.stringify(badFile))).toThrow(/passes.0.file/);
    expect(() => parseSessionIndex("not json")).toThrow(/not JSON/);
  });

  test("should list the title and the scope of each pass", () => {
    const capture = createSessionCapture();
    for (const [scope, title] of [
      ["web", "review-correctness-c0"],
      ["web", "review-correctness-c1"],
      ["api", "review-correctness-c0"],
    ] as const) {
      capture.withScope(scope).note({
        agent: "correctness",
        title,
        source: "claude",
        sessionId: `ses_${scope}_${title}`,
        exportJson: "{}",
      });
    }
    const built = buildSessionIndex(capture, { repo: "expo/expo", pr: 1, headSha: SHA_A });
    expect(built?.index.passes.map((item) => [item.scope, item.title, item.file])).toEqual([
      ["web", "review-correctness-c0", "opencode/correctness.json"],
      ["web", "review-correctness-c1", "opencode/correctness-2.json"],
      ["api", "review-correctness-c0", "opencode/correctness-3.json"],
    ]);
  });

  test("should stop waiting for an export that stalls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ecr-session-stall-"));
    const bin = path.join(dir, "opencode");
    // The sleep is a grandchild, as it is behind a version-manager shim.
    await writeFile(bin, "#!/bin/sh\nsleep 30 &\nwait\n", { mode: 0o755 });
    const capture = createSessionCapture();
    capture.note({
      agent: "correctness",
      title: "review-correctness-c0",
      source: "opencode",
      sessionId: "ses_stalled",
    });
    const log: string[] = [];
    let closed = 0;
    const started = Date.now();
    try {
      await capture.exportOpencode({
        cwd: dir,
        env: process.env,
        bin,
        log: (line) => log.push(line),
        closeServer: () => {
          closed++;
        },
        timeoutMs: 100,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(closed).toBe(1);
    expect(log).toEqual(["session store: could not export correctness (ses_stalled)"]);
  });

  test("should not retry a pass that another scope could not export", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ecr-session-scope-"));
    const bin = path.join(dir, "opencode");
    const exported = JSON.stringify({ info: { id: "ses_api", version: pinnedOpencodeVersion() } });
    // Only the session of the api scope can be exported.
    await writeFile(bin, `#!/bin/sh\n[ "$2" = "ses_api" ] || exit 1\nprintf '%s' '${exported}'\n`, {
      mode: 0o755,
    });
    const capture = createSessionCapture();
    const log: string[] = [];
    let closed = 0;
    const exportScope = async (scope: string): Promise<void> => {
      const scoped = capture.withScope(scope);
      scoped.note({
        agent: "correctness",
        title: "review-correctness-c0",
        source: "opencode",
        sessionId: `ses_${scope}`,
      });
      await scoped.exportOpencode({
        cwd: dir,
        env: process.env,
        bin,
        log: (line) => log.push(line),
        closeServer: () => {
          closed++;
        },
      });
    };
    try {
      await exportScope("web");
      await exportScope("api");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(closed).toBe(1);
    expect(log).toEqual(["session store: could not export correctness (ses_web)"]);
    expect(capture.orderedPasses().map((item) => [item.scope, Boolean(item.exportJson)])).toEqual([
      ["web", false],
      ["api", true],
    ]);
  });

  test("should record the cost of a claude pass on one message", () => {
    const built = buildClaudeSessionExport({
      agent: "correctness",
      system: "",
      text: "prompt",
      model: "anthropic/claude-sonnet-4-5",
      cwd: tmpdir(),
      stdout: claudeSteps(3).join("\n"),
      cost: 0.5,
      tokens: { input: 10, output: 4 },
    });
    const costs = messagesOf(built.json)
      .filter((message) => message.info.role === "assistant")
      .map((message) => message.info.cost);
    expect(costs).toEqual([0, 0, 0.5]);
  });

  test(
    "should import a captured claude export with the pinned opencode",
    async () => {
      const bin = await resolveOpencodeCli();
      expect(bin).toBeTruthy();
      const home = await mkdtemp(path.join(tmpdir(), "ecr-session-import-"));
      const cwd = path.join(home, "repo");
      await mkdir(cwd, { recursive: true });
      const outside = path.join(home, "outside.ts");
      const prompt = "please-roundtrip-this-prompt";
      const built = buildClaudeSessionExport({
        agent: "correctness",
        system: "You are a reviewer.",
        text: prompt,
        model: "anthropic/claude-sonnet-4-5",
        cwd,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-5" }),
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "Read",
                  input: { file_path: outside },
                },
                { type: "text", text: "looking" },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }],
            },
          }),
          ...claudeSteps(5),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "roundtrip-ok" }] },
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "roundtrip-ok",
          }),
        ].join("\n"),
        cost: 0.01,
        tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      expect(built.json).not.toContain(outside);
      expect(built.json).toContain("(outside the review tree)");
      const file = path.join(home, "session.json");
      await writeFile(file, built.json);
      const env = opencodeChildEnv({
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      });
      delete env.OPENCODE_CONFIG;
      delete env.OPENCODE_CONFIG_DIR;
      delete env.OPENCODE_CONFIG_CONTENT;
      try {
        const imported = await run(bin!, ["import", file, "--pure"], {
          cwd,
          env,
          check: false,
          timeout: 120_000,
        });
        if (imported.code !== 0) {
          throw new Error(imported.stderr.trim() || `opencode import exited ${imported.code}`);
        }
        const capture = createSessionCapture();
        capture.note({
          agent: "correctness",
          title: "review-correctness-c0",
          source: "opencode",
          sessionId: built.sessionId,
        });
        await capture.exportOpencode({
          cwd,
          env,
          bin: bin!,
          log: () => {},
          closeServer: () => {},
        });
        const exported = capture.orderedPasses()[0]?.exportJson ?? "";
        expect(sessionIdOf(exported)).toBe(built.sessionId);
        expect(exported).not.toContain(outside);
        // OpenCode sorts by id, so this fails if the export's ids do not ascend.
        const transcript = messagesOf(exported).map(
          (message) =>
            `${message.info.role}: ${message.parts.map((part) => part.text ?? part.tool).join(", ")}`,
        );
        expect(transcript).toEqual([
          `user: ${prompt}`,
          "assistant: looking, read",
          "assistant: step-1, read",
          "assistant: step-2, read",
          "assistant: step-3, read",
          "assistant: step-4, read",
          "assistant: step-5, read",
          "assistant: roundtrip-ok",
        ]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );
});
