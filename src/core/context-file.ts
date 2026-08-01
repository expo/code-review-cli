import { open } from "node:fs/promises";

// @ref LLP 0007#ecr-ci-the-trusted-root-run [constrained-by] — a missing/oversized context file WARNs and continues in ci; never fails checks
/**
 * Hard read ceiling for a `--context-file`. The file is read once in the command
 * layer, byte-bounded here, then head/tail capped again for the prompt
 * (CONTEXT_FILE_MAX_CHARS in prompts.ts). This ceiling bounds the read itself so a
 * multi-gigabyte path can't exhaust memory before the prompt cap ever applies.
 */
export const MAX_CONTEXT_FILE_BYTES = 1_048_576; // 1 MiB

const READ_CHUNK_BYTES = 65_536;

/**
 * Read an external context file as UTF-8 text. Throws on a missing/unreadable path
 * or one over MAX_CONTEXT_FILE_BYTES — the command layer decides whether that is
 * fatal (`ecr review`) or a warn-and-continue (`ecr ci`). The ceiling is enforced
 * DURING the read, not by a stat beforehand: special files (`/dev/zero`, proc
 * entries) report a small or zero size but read without end, and a regular file
 * can grow between a stat and the read. Invalid UTF-8 decodes lossily
 * (replacement chars); control chars are stripped later by sanitizeUntrusted.
 */
export async function readContextFile(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > MAX_CONTEXT_FILE_BYTES) {
        throw new Error(`context file too large (> 1 MiB): ${filePath}`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}
