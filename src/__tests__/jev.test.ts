import { describe, expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import { ReviewConfigSchema, ScopeReviewConfigSchema } from "../config/schema.js";
import { FORBIDDEN_TOKEN_ENVS } from "../core/auth.js";
import { buildJevState, observeFindingsWithJev, withoutJevCredential } from "../core/jev.js";
import type { Finding } from "../core/schema.js";

const finding: Finding = {
  severity: "warning",
  category: "correctness",
  file: "src/example.ts",
  line: 2,
  title: "The fallback returns the wrong value",
  rationale: "The changed branch returns false when the caller requires true.",
  evidence: "return false",
};

const config = {
  enabled: true,
  model: "jev-1.13.0",
  maxFindings: 20,
  timeoutMs: 10_000,
  maxPatchChars: 30_000,
};

describe("Jev config", () => {
  test("is disabled and pinned by default", () => {
    const parsed = ReviewConfigSchema.parse({});
    expect(parsed.jev).toEqual({ ...config, enabled: false });
  });

  test("is root-only", () => {
    expect(ScopeReviewConfigSchema.safeParse({ jev: { enabled: true } }).success).toBe(false);
  });

  test("cannot be repurposed as a reviewer provider credential", () => {
    expect(FORBIDDEN_TOKEN_ENVS.has("TYPESAFE_API_KEY")).toBe(true);
  });
});

describe("observeFindingsWithJev", () => {
  test("does nothing when disabled", async () => {
    expect(
      await observeFindingsWithJev({
        config: { ...config, enabled: false },
        findings: [finding],
        files: [],
        env: {},
      }),
    ).toBeUndefined();
  });

  test("records a missing key without throwing", async () => {
    const observation = await observeFindingsWithJev({
      config,
      findings: [finding],
      files: [],
      env: {},
    });
    expect(observation?.error).toBe("TYPESAFE_API_KEY is not set");
    expect(observation?.findings).toEqual([]);
  });

  test("records typed probabilities without source text", async () => {
    const requests: unknown[] = [];
    const client = new TypeSafeClient({
      apiKey: "test-key",
      defaultModel: config.model,
      retry: { maxRetries: 0 },
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              support: {
                type: "choice",
                choice: "supported",
                confidence: 0.91,
                probabilities: { supported: 0.91, insufficient: 0.07, contradicted: 0.02 },
              },
              severity: {
                type: "choice",
                choice: "warning",
                confidence: 0.8,
                probabilities: { suggestion: 0.1, warning: 0.8, critical: 0.1 },
              },
            },
            usage: { input_tokens: 123, output_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const observation = await observeFindingsWithJev({
      config,
      findings: [finding],
      files: [{ path: finding.file, patch: "@@ -1 +1 @@\n-return true\n+return false" }],
      client,
      env: {},
    });

    expect(requests).toHaveLength(1);
    expect(observation?.evaluated).toBe(1);
    expect(observation?.inputTokens).toBe(123);
    expect(observation?.findings[0]?.support).toBe("supported");
    expect(observation?.findings[0]?.severity).toBe("warning");
    expect(JSON.stringify(observation)).not.toContain("return false");
  });

  test("caps findings and fails open on provider errors", async () => {
    const client = new TypeSafeClient({
      apiKey: "test-key",
      retry: { maxRetries: 0 },
      fetch: async () => {
        throw new Error("request contained sensitive source");
      },
    });
    const observation = await observeFindingsWithJev({
      config: { ...config, maxFindings: 1 },
      findings: [finding, { ...finding, title: "Another finding" }],
      files: [],
      client,
      env: {},
    });

    expect(observation?.failed).toBe(1);
    expect(observation?.skipped).toBe(1);
    expect(observation?.error).toBeUndefined();
    expect(JSON.stringify(observation)).not.toContain("sensitive source");
  });
});

test("buildJevState bounds large patches around the cited evidence", () => {
  const state = buildJevState(
    finding,
    `before-${"x".repeat(2_000)}return false${"y".repeat(2_000)}`,
    1_000,
  );
  expect(state.changedCodePatch.length).toBeLessThanOrEqual(1_000);
  expect(state.changedCodePatch).toContain("return false");
  expect(state.changedCodePatch).toContain("patch omitted by ecr");
});

test("withoutJevCredential restores the key after hiding it from a child spawn", async () => {
  const env = { TYPESAFE_API_KEY: "secret", KEEP: "visible" };
  const seen = await withoutJevCredential(async () => ({ ...env }), env);
  expect(seen).toEqual({ KEEP: "visible" });
  expect(env.TYPESAFE_API_KEY).toBe("secret");
});
