import { test, expect } from "bun:test";

import {
  buildPreCoordinationFileLocks,
  decisionAfterGrounding,
  decisionAfterRequalification,
  decisionAfterVerification,
  groundStackRequalification,
} from "../core/review.js";
import type { Finding } from "../core/schema.js";
import type { StackManifest } from "../sources/source.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "src/foo.ts",
  line: 1,
  title: "no test for parseX",
  rationale: "r",
  evidence: "export function parseX() {}",
  ...over,
});

const requalified = (over: Partial<Finding> = {}): Finding =>
  finding({
    requalifiedBy: { prNumber: 42, file: "src/foo.test.ts", reason: "adds the test" },
    ...over,
  });

const manifest = (files = ["src/foo.test.ts"]): StackManifest => ({
  upstackPRs: [{ number: 42, title: "t", authorLogin: "alice", files }],
  truncated: false,
});

const noLock = new Set<string>();

// Most tests only care about the grounded findings; unwrap them. The stripped
// audit trail has its own test below.
const ground = (...args: Parameters<typeof groundStackRequalification>): Finding[] =>
  groundStackRequalification(...args).findings;

test("grounding keeps a valid, exact-match requalification", () => {
  const [out] = ground([requalified()], manifest(), noLock);
  expect(out!.requalifiedBy).toBeDefined();
});

test("grounding strips a forged citation not in the manifest", () => {
  const forged = requalified({ requalifiedBy: { prNumber: 42, file: "src/evil.ts", reason: "x" } });
  const [out] = ground([forged], manifest(), noLock);
  expect(out!.requalifiedBy).toBeUndefined();
});

test("grounding strips a citation whose PR number is not in the manifest", () => {
  const wrongPr = requalified({
    requalifiedBy: { prNumber: 99, file: "src/foo.test.ts", reason: "x" },
  });
  const [out] = ground([wrongPr], manifest(), noLock);
  expect(out!.requalifiedBy).toBeUndefined();
});

test("grounding never touches critical / secrets / security findings", () => {
  const cases: Finding[] = [
    requalified({ severity: "critical" }),
    requalified({ category: "secrets" }),
    requalified({ category: "security" }),
  ];
  for (const f of cases) {
    const [out] = ground([f], manifest(), noLock);
    expect(out!.requalifiedBy).toBeUndefined();
  }
});

test("severity lock: a downgrade-then-requalify is stripped by a pre-coordination critical", () => {
  // A reviewer emitted a CRITICAL on this file; the coordinator downgraded it to
  // warning and requalified.
  const reviewerCritical = finding({ severity: "critical" });
  const locks = buildPreCoordinationFileLocks({ correctness: [reviewerCritical] });
  const downgraded = requalified({ severity: "warning" });
  const [out] = ground([downgraded], manifest(), locks);
  expect(out!.requalifiedBy).toBeUndefined();
});

test("severity lock: coordinator re-categorization + paraphrase cannot dodge the file lock", () => {
  // The lock is keyed on the FILE, not a content fingerprint: the coordinator
  // rewriting category, title, and evidence must not un-lock the finding.
  const reviewerCritical = finding({ severity: "critical", category: "security" });
  const locks = buildPreCoordinationFileLocks({ security: [reviewerCritical] });
  const mutated = requalified({
    severity: "warning",
    category: "quality",
    title: "reworded title",
    evidence: "totally paraphrased evidence",
  });
  const [out] = ground([mutated], manifest(), locks);
  expect(out!.requalifiedBy).toBeUndefined();
});

test("severity lock: a pre-coordination security/secrets WARNING also locks its file", () => {
  // Re-categorizing a security warning to quality would bypass the category carve-out;
  // the file lock (built from the raw reviewer category) still strips it.
  const reviewerSecurity = finding({ severity: "warning", category: "security" });
  const locks = buildPreCoordinationFileLocks({ security: [reviewerSecurity] });
  const recategorized = requalified({ category: "quality" });
  const [out] = ground([recategorized], manifest(), locks);
  expect(out!.requalifiedBy).toBeUndefined();
});

test("severity lock: locks are per-file — a critical elsewhere does not lock this file", () => {
  const otherFileCritical = finding({ severity: "critical", file: "src/other.ts" });
  const locks = buildPreCoordinationFileLocks({ correctness: [otherFileCritical] });
  const [out] = ground([requalified()], manifest(), locks);
  expect(out!.requalifiedBy).toBeDefined();
});

test("severity lock: file paths are normalized before comparison", () => {
  const reviewerCritical = finding({ severity: "critical", file: "./src/foo.ts" });
  const locks = buildPreCoordinationFileLocks({ correctness: [reviewerCritical] });
  const [out] = ground([requalified({ file: "src/foo.ts" })], manifest(), locks);
  expect(out!.requalifiedBy).toBeUndefined();
});

test("path normalization: a leading ./ on either side still matches exactly", () => {
  const cited = requalified({
    requalifiedBy: { prNumber: 42, file: "./src/foo.test.ts", reason: "x" },
  });
  const [out] = ground([cited], manifest(["src/foo.test.ts"]), noLock);
  expect(out!.requalifiedBy).toBeDefined();
});

test("path normalization: a basename is NOT a match (no substring/basename matching)", () => {
  const cited = requalified({ requalifiedBy: { prNumber: 42, file: "foo.test.ts", reason: "x" } });
  const [out] = ground([cited], manifest(["pkg/a/foo.test.ts"]), noLock);
  expect(out!.requalifiedBy).toBeUndefined();
});

test("grounding emits a debug line naming the stripped finding", () => {
  const logs: string[] = [];
  const forged = requalified({ requalifiedBy: { prNumber: 42, file: "src/evil.ts", reason: "x" } });
  ground([forged], manifest(), noLock, (m) => logs.push(m));
  expect(logs.some((line) => line.includes("src/foo.ts") && line.includes("not an exact"))).toBe(
    true,
  );
});

test("grounding preserves the array length (findings are annotated, never dropped)", () => {
  const forged = requalified({ requalifiedBy: { prNumber: 42, file: "nope.ts", reason: "x" } });
  const grounded = ground([finding(), forged], manifest(), noLock);
  expect(grounded.length).toBe(2);
});

test("decisionAfterRequalification softens over the blocking subset only", () => {
  // One requalified warning, nothing else blocking ⇒ approve.
  expect(decisionAfterRequalification("request_changes", [requalified()])).toBe("approve");
  // A blocking warning alongside a requalified one ⇒ soften from request_changes.
  expect(decisionAfterRequalification("request_changes", [finding(), requalified()])).toBe(
    "approve_with_comments",
  );
  // A blocking critical still blocks.
  expect(
    decisionAfterRequalification("request_changes", [
      finding({ severity: "critical" }),
      requalified(),
    ]),
  ).toBe("request_changes");
});

test("decision-changes-without-count-drop: grounding softens the decision while keeping every finding", () => {
  // request_changes with a single requalified warning. Grounding keeps the finding
  // (count unchanged) but the decision softens — the exact case the extended reconcile
  // trigger must fire on.
  const findings = [requalified()];
  const grounded = ground(findings, manifest(), noLock);
  const decision = decisionAfterRequalification("request_changes", grounded);
  expect(grounded.length).toBe(findings.length); // no count drop
  expect(decision).toBe("approve"); // decision changed
  expect(decision).not.toBe("request_changes");
});

test("decision lock: the suppression re-derivation can't re-escalate the softened decision", () => {
  // After requalification softens to approve, the suppression block re-derives over
  // the full (still non-empty) finding list; it must not push the decision back up,
  // because no requalified finding is critical.
  const grounded = ground([requalified()], manifest(), noLock);
  const softened = decisionAfterRequalification("request_changes", grounded);
  expect(softened).toBe("approve");
  // The suppression block's re-derivation over the kept list keeps it at approve.
  expect(decisionAfterRequalification(softened, grounded)).toBe("approve");
});

test("suppression re-derives over the blocking subset: suppressing the last blocking finding → approve", () => {
  // approve_with_comments held because one blocking warning remained beside a
  // requalified one; an inline ignore then suppresses the blocking warning. The
  // post-suppression decision must re-derive over the BLOCKING subset (the kept list
  // is only the requalified finding) and reach approve — decisionAfterVerification
  // would keep a stale approve_with_comments here since kept is non-empty.
  const kept = [requalified()];
  expect(decisionAfterRequalification("approve_with_comments", kept)).toBe("approve");
  expect(decisionAfterVerification("approve_with_comments", kept)).toBe("approve_with_comments");
});

test("grounding returns the stripped requalifications with their reasons (run-log trail)", () => {
  const forged = requalified({ requalifiedBy: { prNumber: 42, file: "src/evil.ts", reason: "x" } });
  const kept = requalified();
  const { findings, stripped } = groundStackRequalification(
    [forged, kept, finding()],
    manifest(),
    noLock,
  );
  expect(findings.length).toBe(3);
  expect(stripped.length).toBe(1);
  expect(stripped[0]!.finding.file).toBe("src/foo.ts");
  expect(stripped[0]!.finding.requalifiedBy).toBeUndefined();
  expect(stripped[0]!.reason).toContain("not an exact manifest member");
});

test("decisionAfterGrounding: without a surviving requalification the decision stands", () => {
  // The everyday case (stack feature off, or every requalification stripped): a
  // non-critical request_changes must NOT soften — the coordinator's decision is
  // only re-derived when a requalification actually survived grounding.
  expect(decisionAfterGrounding("request_changes", [finding()])).toBe("request_changes");
  expect(decisionAfterGrounding("approve_with_comments", [finding()])).toBe(
    "approve_with_comments",
  );
  // With a surviving requalification it defers to decisionAfterRequalification.
  expect(decisionAfterGrounding("request_changes", [requalified()])).toBe("approve");
  expect(decisionAfterGrounding("request_changes", [finding(), requalified()])).toBe(
    "approve_with_comments",
  );
});
