import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyFindings, matchEvidence, evidenceFragments } from "../core/verify.js";
import type { Finding } from "../core/schema.js";
import type { OpencodeHandle } from "../core/opencode.js";

const FILE_CONTENT = [
  "export const answer = 42;",
  "function realThing() {",
  "  return items[next++]!;",
  "}",
].join("\n");

// ---- pure matching (matchEvidence / evidenceFragments) ----

test("matchEvidence: exact (whitespace-normalized) substring is present", () => {
  expect(matchEvidence("return items[next++]!;", FILE_CONTENT)).toBe("present");
  expect(matchEvidence("  return   items[next++]!;  ", FILE_CONTENT)).toBe("present");
});

test("matchEvidence: fuzzy — a cross-line quote still matches on a contiguous line", () => {
  // Evidence joins two non-adjacent lines; the exact join is not a substring, but
  // one substantive line is → present (rescues cross-line quotes).
  const evidence = "function realThing() {\n  return items[next++]!;";
  expect(matchEvidence(evidence, FILE_CONTENT)).toBe("present");
});

test("matchEvidence: fuzzy — ellipsis elision matches on a fragment", () => {
  expect(matchEvidence("function realThing() { … return items[next++]!; }", FILE_CONTENT)).toBe(
    "present",
  );
});

test("matchEvidence: fuzzy — copied comment/diff markers are stripped before matching", () => {
  expect(matchEvidence("+  return items[next++]!;", FILE_CONTENT)).toBe("present");
  expect(matchEvidence("// return items[next++]!;", FILE_CONTENT)).toBe("present");
});

test("matchEvidence: a genuinely invented quote is absent", () => {
  expect(matchEvidence("const item = next++; // nowhere in the file", FILE_CONTENT)).toBe("absent");
});

test("matchEvidence: too-short evidence is unknown (never conclude absent)", () => {
  expect(matchEvidence("x}", FILE_CONTENT)).toBe("unknown");
  expect(matchEvidence("", FILE_CONTENT)).toBe("unknown");
});

test("evidenceFragments: splits on newlines + ellipsis, strips markers, drops short bits", () => {
  const frags = evidenceFragments(
    "+  return items[next++]!;\n// x\nconst somethingLongEnough = 1;",
  );
  expect(frags).toContain("return items[next++]!;");
  expect(frags).toContain("const somethinglongenough = 1;"); // normalized (lowercased)
  expect(frags.some((f) => f === "x")).toBe(false); // too short, dropped
});

// ---- verifyFindings integration ----

let dir: string;
let file: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ecr-verify-test-"));
  file = path.join(dir, "sample.ts");
  writeFileSync(file, FILE_CONTENT);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const finding = (over: Partial<Finding>): Finding => ({
  severity: "warning",
  category: "correctness",
  file,
  line: 1,
  title: "T",
  rationale: "r",
  ...over,
});

// A dummy handle: any LLM verify call throws, which exercises the fail-OPEN path
// (keep the finding). Grounded non-criticals never reach the LLM at all.
const handle = {} as OpencodeHandle;

test("grounded non-critical is kept without an LLM call", async () => {
  const res = await verifyFindings(
    handle,
    [finding({ title: "present", evidence: "return items[next++]!;" })],
    "/",
  );
  expect(res.kept.map((f) => f.title)).toEqual(["present"]);
  expect(res.dropped).toEqual([]);
});

test("absent evidence is ESCALATED, not hard-dropped (fail-open keeps it here)", async () => {
  // The key regression guard: an imperfect/absent quote must not be a silent drop.
  // With the dummy handle the escalated LLM call throws → fail-open → kept.
  const res = await verifyFindings(
    handle,
    [finding({ title: "absent-but-maybe-real", evidence: "const item = next++; // not in file" })],
    "/",
  );
  expect(res.kept.map((f) => f.title)).toEqual(["absent-but-maybe-real"]);
  expect(res.dropped).toEqual([]);
});

test("too-short evidence is unknown, kept without an LLM call", async () => {
  const res = await verifyFindings(handle, [finding({ title: "short", evidence: "x}" })], "/");
  expect(res.kept.map((f) => f.title)).toEqual(["short"]);
  expect(res.dropped).toEqual([]);
});

test("a cited finding always escalates to the LLM verifier (fail-open keeps its citation)", async () => {
  // The repo alone cannot confirm an external-behavior claim, so grounded
  // evidence does NOT skip the LLM check when the finding cites documentation.
  // With the dummy handle the escalated call throws → fail-open: the finding
  // AND its citation survive, and nothing is reported citation-stripped.
  const url = "https://developer.apple.com/documentation/network/nwpathmonitor";
  const escalations: string[] = [];
  const res = await verifyFindings(
    handle,
    [
      finding({
        title: "cited",
        evidence: "return items[next++]!;", // present → would be kept LLM-free if uncited
        sources: [{ title: "NWPathMonitor", url }],
      }),
    ],
    dir,
    (message) => escalations.push(message),
    [
      {
        query: { platform: "apple", providers: ["apple"], query: "NWPathMonitor" },
        provider: "apple",
        sourceKind: "official-api",
        title: "NWPathMonitor",
        url,
        passage: "Observe network path changes with a path update handler.",
      },
    ],
  );
  expect(res.kept.map((f) => f.title)).toEqual(["cited"]);
  expect(res.kept[0]?.sources).toEqual([{ title: "NWPathMonitor", url }]);
  expect(res.citationStripped).toEqual([]);
  expect(escalations.some((m) => m.includes("could not verify"))).toBe(true);
});

test("a cited finding whose sources match no audited evidence stays on the cheap path", async () => {
  // citedSourcesFor finds nothing → no passages to judge → ordinary rules apply
  // (present + non-critical → kept without an LLM call).
  const escalations: string[] = [];
  const res = await verifyFindings(
    handle,
    [
      finding({
        title: "cited-unmatched",
        evidence: "return items[next++]!;",
        sources: [{ title: "Doc", url: "https://developer.apple.com/documentation/other" }],
      }),
    ],
    dir,
    (message) => escalations.push(message),
    [],
  );
  expect(res.kept.map((f) => f.title)).toEqual(["cited-unmatched"]);
  expect(escalations.some((m) => m.includes("could not verify"))).toBe(false);
});

test("unreadable file is unknown, never dropped", async () => {
  const f = finding({
    title: "missing-file",
    file: "/no/such/file.ts",
    evidence: "const somethingLongEnough = 1;",
  });
  const res = await verifyFindings(handle, [f], "/");
  expect(res.kept.map((x) => x.title)).toEqual(["missing-file"]);
});

// ---- path confinement: an LLM-authored finding.file must never read outside cwd ----

test("finding.file outside cwd is never read (treated as unknown, no LLM escalation)", async () => {
  // The out-of-tree file EXISTS and its content would NOT match the evidence, so the
  // pre-fix code would read it, grade the quote `absent`, and escalate to the LLM
  // verifier. Confining the read to cwd means the file is never opened: the finding is
  // graded `unknown` and kept WITHOUT any verify call — which is the observable signal
  // that the raw readFile did not reach the out-of-tree (credential-shaped) path.
  const outside = mkdtempSync(path.join(tmpdir(), "ecr-verify-outside-"));
  const secret = path.join(outside, "credentials.ts");
  writeFileSync(secret, FILE_CONTENT);
  try {
    const escalations: string[] = [];
    const res = await verifyFindings(
      handle,
      [
        finding({
          title: "traversal",
          file: secret, // absolute path OUTSIDE the review cwd
          evidence: "const item = next++; // not in that file",
        }),
      ],
      dir, // cwd is the in-tree review root, not "/"
      (message) => escalations.push(message),
    );
    expect(res.kept.map((f) => f.title)).toEqual(["traversal"]);
    expect(escalations.some((m) => /verify:/.test(m))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("in-tree absent evidence still escalates (confinement control)", async () => {
  // Same absent evidence, but the file is INSIDE cwd: it is read, graded `absent`, and
  // escalated — proving the mechanism runs and the difference above is the confinement.
  const escalations: string[] = [];
  const res = await verifyFindings(
    handle,
    [finding({ title: "in-tree", file, evidence: "const item = next++; // not in file" })],
    dir,
    (message) => escalations.push(message),
  );
  expect(res.kept.map((f) => f.title)).toEqual(["in-tree"]);
  expect(escalations.some((m) => m.includes("could not verify"))).toBe(true);
});

test("finding.file with a `..` escape is confined (unknown, no LLM escalation)", async () => {
  const escalations: string[] = [];
  const res = await verifyFindings(
    handle,
    [
      finding({
        title: "dotdot",
        file: "../../../../etc/hosts",
        evidence: "const item = next++; // not in that file",
      }),
    ],
    dir,
    (message) => escalations.push(message),
  );
  expect(res.kept.map((f) => f.title)).toEqual(["dotdot"]);
  expect(escalations.some((m) => /verify:/.test(m))).toBe(false);
});
