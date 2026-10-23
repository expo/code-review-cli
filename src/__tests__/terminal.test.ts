import { test, expect } from "bun:test";

import type { CoordinatorOutput, Finding } from "../core/schema.js";
import { TerminalReporter } from "../reporters/terminal.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "T",
  rationale: "r",
  ...over,
});

// The reporter colors only a TTY and writes the report to stdout, so force the
// one and capture the other by swapping the method directly.
async function captureTty(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalExitCode = process.exitCode;
  const chunks: string[] = [];
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
    if (originalTty) {
      Object.defineProperty(process.stdout, "isTTY", originalTty);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    process.exitCode = originalExitCode;
  }
  return chunks.join("");
}

test("terminal reporter: design and nit groups get their own label and color, in rank order", async () => {
  const review: CoordinatorOutput = {
    decision: "approve_with_comments",
    findings: [
      finding({ severity: "nit", title: "N" }),
      finding({ severity: "design", title: "D" }),
      finding({ severity: "warning", title: "W" }),
    ],
    summary: "s",
    incomplete: [],
  };
  const out = await captureTty(() => new TerminalReporter().report(review));
  const design = out.indexOf("\x1b[1m\x1b[35mDESIGN (1)");
  const nit = out.indexOf("\x1b[1m\x1b[90mNIT (1)");
  expect(out.indexOf("\x1b[1m\x1b[33mWARNING (1)")).toBeGreaterThan(-1);
  expect(design).toBeGreaterThan(out.indexOf("WARNING (1)"));
  expect(nit).toBeGreaterThan(design);
  expect(out).toContain("\x1b[35m1 design");
  expect(out).toContain("\x1b[90m1 nit");
});
