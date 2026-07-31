export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A failure reason safe to post into a PUBLIC PR comment (see `ecr ci`'s failure
 * notices). `run` (core/exec.ts) throws "Command failed: <cmd> <argv>\n<stderr>" (and
 * "Command output exceeded …"), which embeds a subprocess's full command line, its
 * stderr, and absolute runner paths — CI-internal detail of no use to a PR author and
 * exactly the kind of thing that must not leak into an attacker-visible artifact. Those
 * shapes collapse to a generic pointer at the workflow log; our own (argv/path-free)
 * error messages pass through, since they are the actionable ones the fail-fast design
 * means to surface. Every call site still writes the FULL reason to the job's stderr.
 */
export function publicFailureReason(error: unknown): string {
  const message = errorMessage(error);
  if (/^Command (failed|output exceeded)\b/.test(message)) {
    return "a subprocess (gh, git, or the model CLI) failed — see the workflow logs for details";
  }
  return message;
}

/** Collapse whitespace + lowercase — for tolerant code matching / fingerprinting. */
export function normalizeCode(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
