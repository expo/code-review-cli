import { test, expect } from "bun:test";

import {
  extractJsonObject,
  fingerprintFinding,
  parseCoordinatorOutput,
  parseReviewerOutput,
} from "../core/schema.js";
import type { Finding } from "../core/schema.js";

test("extractJsonObject: fenced ```json block", () => {
  expect(extractJsonObject('prose\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 });
});

test("extractJsonObject: outermost-brace fallback", () => {
  expect(extractJsonObject('here it is: {"a":2} done')).toEqual({ a: 2 });
});

test("extractJsonObject: throws on non-JSON", () => {
  expect(() => extractJsonObject("no json at all")).toThrow();
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "Title",
  rationale: "r",
  ...over,
});

test("fingerprint is line-independent and stable", () => {
  expect(fingerprintFinding(finding({ line: 1 }))).toBe(fingerprintFinding(finding({ line: 99 })));
});

test("fingerprint (evidence-less) falls back to title", () => {
  expect(fingerprintFinding(finding({ title: "A" }))).not.toBe(
    fingerprintFinding(finding({ title: "B" })),
  );
  expect(fingerprintFinding(finding({ file: "a.ts" }))).not.toBe(
    fingerprintFinding(finding({ file: "b.ts" })),
  );
});

test("fingerprint v2: keys on evidence, not the (nondeterministic) title", () => {
  const a = finding({ title: "Null deref here", evidence: "return items[next++]!;" });
  const b = finding({ title: "Possible null dereference", evidence: "return items[next++]!;" });
  // Same code, different LLM wording → same fingerprint (so a dismissal is stable).
  expect(fingerprintFinding(a)).toBe(fingerprintFinding(b));
  // Different code → different fingerprint (dismissal lapses when the code changes).
  const c = finding({ title: "Null deref here", evidence: "const totally = different();" });
  expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(c));
});

// Finding 84c48af4a538: `agent` is engine attribution, but it is a RECOGNIZED key of
// FindingSchema, so zod's strip could not drop it and a reviewer pass or the coordinator
// (both of which read the untrusted PR diff) could dictate what the comment shows. The
// model-facing schema omits it, so it is dropped where model JSON becomes typed data.
test("a forged `agent` in model output is dropped at the parse boundary", () => {
  const raw =
    '{"decision":"approve_with_comments","summary":"s","findings":[' +
    '{"severity":"warning","category":"quality","file":"a.ts","title":"T","rationale":"r",' +
    '"agent":"security","evidence":"const somethingLongEnough = 1;"}]}';
  const coordinator = parseCoordinatorOutput(raw);
  expect(coordinator.findings[0]!.agent).toBeUndefined();
  const reviewer = parseReviewerOutput(raw);
  expect(reviewer.findings[0]!.agent).toBeUndefined();
  // Everything else the model legitimately emits survives, so the strip is targeted.
  expect(coordinator.findings[0]!.title).toBe("T");
  expect(coordinator.findings[0]!.evidence).toBe("const somethingLongEnough = 1;");

  // And with the field cleared, the engine's own fingerprint lookup is the only writer:
  // the attribution the run recorded for that fingerprint is what ends up on the finding.
  const agentByFp = new Map([[fingerprintFinding(coordinator.findings[0]!), "correctness"]]);
  const attributed = coordinator.findings.map((f) => {
    const agent = agentByFp.get(fingerprintFinding(f));
    return agent ? { ...f, agent } : f;
  });
  expect(attributed[0]!.agent).toBe("correctness");
});

test("extractJsonObject: an empty response names the cause instead of 'undefined'", () => {
  expect(() => extractJsonObject("")).toThrow(/an EMPTY response/);
  expect(() => extractJsonObject("prose with no json at all")).toThrow(/no \{\.\.\.\}/);
});
