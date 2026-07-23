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

test("unreadable file is unknown, never dropped", async () => {
  const f = finding({
    title: "missing-file",
    file: "/no/such/file.ts",
    evidence: "const somethingLongEnough = 1;",
  });
  const res = await verifyFindings(handle, [f], "/");
  expect(res.kept.map((x) => x.title)).toEqual(["missing-file"]);
});
