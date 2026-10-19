import { describe, expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import { ReviewConfigSchema, ScopeReviewConfigSchema } from "../config/schema.js";
import { FORBIDDEN_TOKEN_ENVS } from "../core/auth.js";
import {
  buildJevState,
  evaluateFindingsWithJev,
  jevDisposition,
  withoutJevCredential,
} from "../core/jev.js";
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
  model: "jev-1.13.0",
  minConfidence: 0.9,
  timeoutMs: 10_000,
  maxContextChars: 30_000,
};

describe("Jev config", () => {
  test("is activated by presence and absent by default", () => {
    expect(ReviewConfigSchema.parse({}).jev).toBeUndefined();
    expect(ReviewConfigSchema.parse({ jev: {} }).jev).toEqual(config);
  });

  test("is root-only", () => {
    expect(ScopeReviewConfigSchema.safeParse({ jev: {} }).success).toBe(false);
  });

  test("cannot be repurposed as a reviewer provider credential", () => {
    expect(FORBIDDEN_TOKEN_ENVS.has("TYPESAFE_API_KEY")).toBe(true);
  });
});

describe("evaluateFindingsWithJev", () => {
  test("falls back cleanly when the key is missing", async () => {
    const result = await evaluateFindingsWithJev({
      config,
      candidates: [{ finding, sourceContext: "return false" }],
      env: {},
    });
    expect(result.summary.unavailable).toBe("TYPESAFE_API_KEY is not set");
    expect(result.evaluations.size).toBe(0);
  });

  test("returns a typed atomic judgment without persisting source", async () => {
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
                probabilities: { supported: 0.91, needs_reasoning: 0.07, contradicted: 0.02 },
              },
            },
            usage: { input_tokens: 123, output_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await evaluateFindingsWithJev({
      config,
      candidates: [{ finding, sourceContext: "export function fallback() { return false }" }],
      client,
      env: {},
    });

    expect(requests).toHaveLength(1);
    expect(result.summary.evaluated).toBe(1);
    expect(result.summary.inputTokens).toBe(123);
    expect([...result.evaluations.values()][0]?.support).toBe("supported");
    expect(JSON.stringify(result.summary)).not.toContain("return false");
  });

  test("fails open per finding on provider errors", async () => {
    const client = new TypeSafeClient({
      apiKey: "test-key",
      retry: { maxRetries: 0 },
      fetch: async () => {
        throw new Error("request contained sensitive source");
      },
    });
    const result = await evaluateFindingsWithJev({
      config,
      candidates: [{ finding, sourceContext: "secret source" }],
      client,
      env: {},
    });

    expect(result.summary.failed).toBe(1);
    expect(result.summary.unavailable).toBeUndefined();
    expect(JSON.stringify(result.summary)).not.toContain("sensitive source");
  });
});

describe("jevDisposition", () => {
  const evaluation = (
    support: "supported" | "needs_reasoning" | "contradicted",
    confidence = 0.95,
  ) => ({
    fingerprint: "fp",
    model: config.model,
    support,
    confidence,
    probabilities: { supported: 0.02, needs_reasoning: 0.03, contradicted: 0.95 },
  });

  test("acts on clear ordinary findings and defers uncertainty", () => {
    expect(jevDisposition(finding, evaluation("supported"), 0.9)).toBe("keep");
    expect(jevDisposition(finding, evaluation("contradicted"), 0.9)).toBe("drop");
    expect(jevDisposition(finding, evaluation("needs_reasoning"), 0.9)).toBe("defer");
    expect(jevDisposition(finding, evaluation("contradicted", 0.89), 0.9)).toBe("defer");
  });

  test("never drops protected or cited findings by itself", () => {
    expect(
      jevDisposition({ ...finding, category: "security" }, evaluation("contradicted"), 0.9),
    ).toBe("defer");
    expect(
      jevDisposition({ ...finding, severity: "critical" }, evaluation("contradicted"), 0.9),
    ).toBe("defer");
    expect(
      jevDisposition(
        { ...finding, sources: [{ title: "Docs", url: "https://example.com/docs" }] },
        evaluation("supported"),
        0.9,
      ),
    ).toBe("defer");
  });
});

test("buildJevState bounds large source around the cited evidence", () => {
  const state = buildJevState(
    finding,
    `before-${"x".repeat(2_000)}return false${"y".repeat(2_000)}`,
    1_000,
  );
  expect(state.sourceContext.length).toBeLessThanOrEqual(1_000);
  expect(state.sourceContext).toContain("return false");
  expect(state.sourceContext).toContain("source omitted by ecr");
});

test("withoutJevCredential restores the key after hiding it from a child spawn", async () => {
  const env = { TYPESAFE_API_KEY: "secret", KEEP: "visible" };
  const seen = await withoutJevCredential(async () => ({ ...env }), env);
  expect(seen).toEqual({ KEEP: "visible" });
  expect(env.TYPESAFE_API_KEY).toBe("secret");
});
