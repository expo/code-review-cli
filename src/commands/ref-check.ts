// @ref LLP 0012#run-points-command-and-review — the gating run point: exit 1 on any broken ref
import path from "node:path";

import { checkConfigRefs } from "../core/config-refs.js";
import type { RefProblem } from "../core/config-refs.js";
import { repoRoot } from "../core/exec.js";
import { errorMessage } from "../core/util.js";

const USAGE = `ecr ref-check — fail when the review setup cites code that moved or vanished

Usage:
  ecr ref-check [--root <dir>] [--json]

Sweeps every .expo-code-review/ directory in the repo (root and scopes) and checks
that each code citation still resolves against this checkout:
  • \`@ref <target>\` annotations in prompts and configs. A target is a file, a
    directory (trailing slash), \`glob:<pattern>\`, a \`file#symbol\`, or a
    \`doc.md#heading\`. Never a line number — lines rot silently.
  • Unannotated citations: a backticked token that looks like a repo path must be a
    ref, so nothing cites code without being checked. Use \`@ref-ignore <token>\`
    for a token that is not a path.
  • Structural refs the config already declares: enforceAgents ids, scope config
    directories, and scope path globs.
Exit 0 = every ref holds. Exit 1 = at least one is broken.

Options:
  --root <dir>   Repository root to check (default: the current git repo).
  --json         Emit {ok, problems:[{file, line, kind, problem}]} on stdout.
`;

const KIND_LABEL: Record<RefProblem["kind"], string> = {
  "broken-ref": "broken ref",
  "line-number-ref": "line-number ref",
  "unannotated-citation": "unannotated citation",
  structural: "structural ref",
};

export async function refCheckCommand(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  let root: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--root") {
      root = argv[++i];
      // A flag-shaped value means the directory was forgotten: taking it would check
      // some nonexistent path and report "all resolve" while swallowing the real flag.
      if (!root || root.startsWith("-")) {
        process.stderr.write("ecr ref-check: --root needs a directory\n");
        process.exitCode = 2;
        return;
      }
    } else {
      process.stderr.write(`ecr ref-check: unknown argument ${arg}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
  }

  try {
    const resolvedRoot = root ? path.resolve(root) : ((await repoRoot()) ?? process.cwd());
    const report = await checkConfigRefs({ root: resolvedRoot });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: report.ok, problems: report.problems })}\n`);
    } else if (report.ok) {
      process.stdout.write(
        `ref-check: ${report.refs.length} ref(s) across ${report.scannedFiles.length} setup file(s) — all resolve\n`,
      );
    } else {
      for (const problem of report.problems) {
        process.stderr.write(
          `${problem.file}:${problem.line}: ${KIND_LABEL[problem.kind]}: ${problem.problem}\n`,
        );
      }
      process.stderr.write(
        `\nref-check: ${report.problems.length} problem(s). Update the ref or the prompt that cites it.\n`,
      );
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`ecr ref-check: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
