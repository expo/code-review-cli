import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { run } from "../core/exec.js";
import { resolveOpencodeCli } from "../core/opencode.js";
import {
  assertReadableExport,
  buildClaudeSessionExport,
  createSessionCapture,
  defaultSessionPass,
  opencodeChildEnv,
  pinnedOpencodeVersion,
  recordedShaBlocksAttach,
  sessionIdOf,
  SESSION_ZIP_LIMIT_BYTES,
  zipTooLarge,
} from "../core/session-archive.js";
import type { SessionIndexPass } from "../core/session-archive.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function pass(agent: string): SessionIndexPass {
  return {
    agent,
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
        const exported = await run(bin!, ["export", built.sessionId, "--pure"], {
          cwd,
          env,
          check: false,
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        if (exported.code !== 0) {
          throw new Error(exported.stderr.trim() || `opencode export exited ${exported.code}`);
        }
        expect(sessionIdOf(exported.stdout)).toBe(built.sessionId);
        expect(exported.stdout).toContain(prompt);
        expect(exported.stdout).not.toContain(outside);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );
});
