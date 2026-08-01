import { test, expect } from "bun:test";

import { createVerboseEmitter } from "../core/opencode.js";
import type { VerbosePart } from "../core/opencode.js";
import { envFlag } from "../core/util.js";

test("createVerboseEmitter: streams only complete text lines, then flushes the tail", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = { id: "t1", type: "text", text: "line one\nline tw" };
  // Only the complete line is emitted; the partial tail is held back.
  expect(emit([part], false)).toEqual(["> line one"]);
  // No change ⇒ nothing new.
  expect(emit([part], false)).toEqual([]);
  // The tail grows into a full line plus a new partial.
  part.text = "line one\nline two\nline th";
  expect(emit([part], false)).toEqual(["> line two"]);
  // Flush (message completed) emits the remaining partial line.
  expect(emit([part], true)).toEqual(["> line th"]);
  // A second flush emits nothing.
  expect(emit([part], true)).toEqual([]);
});

test("createVerboseEmitter: reasoning parts use the reasoning prefix", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = { id: "r1", type: "reasoning", text: "hmm\n" };
  expect(emit([part], false)).toEqual(["· hmm"]);
});

test("createVerboseEmitter: a part with an end time is emitted without waiting for a newline", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = {
    id: "t1",
    type: "text",
    text: "done, no trailing newline",
    time: { start: 1, end: 2 },
  };
  expect(emit([part], false)).toEqual(["> done, no trailing newline"]);
});

test("createVerboseEmitter: synthetic text parts are skipped", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = { id: "s1", type: "text", text: "injected\n", synthetic: true };
  expect(emit([part], true)).toEqual([]);
});

test("createVerboseEmitter: tool call reports input once, then output on completion", () => {
  const emit = createVerboseEmitter();
  const running: VerbosePart = {
    id: "p1",
    type: "tool",
    tool: "read",
    callID: "c1",
    state: { status: "running", title: "src/foo.ts", input: { filePath: "src/foo.ts" } },
  };
  expect(emit([running], false)).toEqual(['→ read: src/foo.ts {"filePath":"src/foo.ts"}']);
  // Same status again ⇒ silent.
  expect(emit([running], false)).toEqual([]);
  const completed: VerbosePart = {
    ...running,
    state: { ...running.state, status: "completed", output: "1  const a = 1\n2  const b = 2" },
  };
  expect(emit([completed], false)).toEqual(["  │ 1  const a = 1", "  │ 2  const b = 2"]);
});

test("createVerboseEmitter: a tool first seen at completed still reports the call line", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = {
    id: "p1",
    type: "tool",
    tool: "grep",
    callID: "c1",
    state: { status: "completed", title: "pattern", input: { pattern: "x" }, output: "hit" },
  };
  expect(emit([part], false)).toEqual(['→ grep: pattern {"pattern":"x"}', "  │ hit"]);
});

test("createVerboseEmitter: tool errors are surfaced", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = {
    id: "p1",
    type: "tool",
    tool: "read",
    callID: "c1",
    state: { status: "error", input: {}, error: "file not found" },
  };
  expect(emit([part], false)).toEqual(["→ read", "  ✗ read: file not found"]);
});

test("createVerboseEmitter: long tool output is truncated with a size note", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = {
    id: "p1",
    type: "tool",
    tool: "read",
    callID: "c1",
    state: { status: "completed", input: {}, output: "x".repeat(5000) },
  };
  const lines = emit([part], false);
  // Call line + one (truncated) output line.
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("…(+3000 chars)");
});

test("createVerboseEmitter: pending tool calls are not reported", () => {
  const emit = createVerboseEmitter();
  const part: VerbosePart = {
    id: "p1",
    type: "tool",
    tool: "read",
    callID: "c1",
    state: { status: "pending", input: {} },
  };
  expect(emit([part], false)).toEqual([]);
});

test("envFlag: unset/empty/off values are false, everything else is true", () => {
  expect(envFlag(undefined)).toBe(false);
  expect(envFlag("")).toBe(false);
  expect(envFlag("0")).toBe(false);
  expect(envFlag("false")).toBe(false);
  expect(envFlag("FALSE")).toBe(false);
  expect(envFlag("no")).toBe(false);
  expect(envFlag("off")).toBe(false);
  expect(envFlag("1")).toBe(true);
  expect(envFlag("true")).toBe(true);
  expect(envFlag("yes")).toBe(true);
});
