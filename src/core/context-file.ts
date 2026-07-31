import { readFile, stat } from "node:fs/promises";

// @ref LLP 0007#ecr-ci-the-trusted-root-run [constrained-by] — a missing/oversized context file WARNs and continues in ci; never fails checks
/**
 * Hard read ceiling for a `--context-file`. The file is read once in the command
 * layer, byte-bounded here, then head/tail capped again for the prompt
 * (CONTEXT_FILE_MAX_CHARS in prompts.ts). This ceiling bounds the read itself so a
 * multi-gigabyte path can't exhaust memory before the prompt cap ever applies.
 */
export const MAX_CONTEXT_FILE_BYTES = 1_048_576; // 1 MiB

/**
 * Read an external context file as UTF-8 text. Throws on a missing/unreadable path
 * or one over MAX_CONTEXT_FILE_BYTES — the command layer decides whether that is
 * fatal (`ecr review`) or a warn-and-continue (`ecr ci`). Invalid UTF-8 is read
 * lossily (replacement chars); control chars are stripped later by
 * sanitizeUntrusted. No truncation here — the returned text is byte-bounded only.
 */
export async function readContextFile(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (info.size > MAX_CONTEXT_FILE_BYTES) {
    throw new Error(`context file too large (> 1 MiB): ${filePath}`);
  }
  return readFile(filePath, "utf8");
}
