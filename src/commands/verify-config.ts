import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIRNAME, stripJsonComments, stripTrailingCommas } from "../config/load.js";
import { ROUTING_FILENAME } from "../config/routing.js";
import { repoRoot } from "../core/exec.js";
import { errorMessage } from "../core/util.js";

const USAGE = `ecr verify-config — refuse to run when a checked-out config could redirect the model credential

Usage:
  ecr verify-config [--expected <ENV_NAME>] [--json]

The canonical pre-review guard (ships with the CLI). It sweeps EVERY
.expo-code-review/config.jsonc|config.json and routing.jsonc in the repo via a
plain recursive walk (skipping node_modules/.git, so a staged-but-unreferenced
config can't hide from git's index), parses each with the real comment-aware JSONC
parser (never regex-scraping), and refuses to run (exit 1) when:
  • auth.tokenEnv (config) / defaults.auth.tokenEnv (routing.jsonc) appears more
    than once, or in a non-root file, or — with --expected / ECR_EXPECTED_TOKEN_ENV
    set — differs from the expected name or is absent (count must be exactly one);
  • a non-root config declares auth, breakGlass, or commentTag (root-locked keys);
  • any file fails to parse (fail-closed), reporting the parse error.
Exit 0 = safe to run the review.

Options:
  --expected <ENV_NAME>   Require tokenEnv to equal this (else ECR_EXPECTED_TOKEN_ENV).
  --json                  Emit {ok, findings:[{file, problem}]} on stdout.
`;

export interface VerifyFinding {
  /** Repo-relative path of the offending file (or a comma list for cross-file issues). */
  file: string;
  problem: string;
}

export interface VerifyResult {
  ok: boolean;
  findings: VerifyFinding[];
}

interface ConfigFacts {
  /** tokenEnv value declared (config auth.tokenEnv / routing defaults.auth.tokenEnv). */
  tokenEnv?: string;
  declaresAuth: boolean;
  declaresBreakGlass: boolean;
  declaresCommentTag: boolean;
}

const CONFIG_FILENAMES = new Set(["config.jsonc", "config.json", ROUTING_FILENAME]);

/**
 * Discover every config the CLI could ever read via a plain recursive walk (not
 * `git ls-files`): a PR can't hide an unreferenced/untracked config dir from an
 * on-disk sweep the way it could from git's index. Skips node_modules and .git.
 */
async function discoverConfigFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — nothing to sweep here
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        await walk(path.join(dir, entry.name));
      } else if (
        entry.isFile() &&
        path.basename(dir) === CONFIG_DIRNAME &&
        CONFIG_FILENAMES.has(entry.name)
      ) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return found.sort();
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read the security-relevant declarations from a parsed config/routing object. */
function extractFacts(file: string, parsed: Record<string, unknown>): ConfigFacts {
  if (path.basename(file) === ROUTING_FILENAME) {
    // routing.jsonc locks auth under defaults.auth (defaults.auth.tokenEnv).
    const defaults = asObject(parsed.defaults);
    const auth = asObject(defaults?.auth);
    return {
      tokenEnv: typeof auth?.tokenEnv === "string" ? auth.tokenEnv : undefined,
      declaresAuth: Boolean(defaults) && "auth" in defaults!,
      declaresBreakGlass: false, // routing.jsonc has no breakGlass concept
      declaresCommentTag: Boolean(defaults) && "commentTag" in defaults!,
    };
  }
  const auth = asObject(parsed.auth);
  return {
    tokenEnv: typeof auth?.tokenEnv === "string" ? auth.tokenEnv : undefined,
    declaresAuth: "auth" in parsed,
    declaresBreakGlass: "breakGlass" in parsed,
    declaresCommentTag: "commentTag" in parsed,
  };
}

/**
 * Verify every discoverable config is safe to run a review against. Fail-closed:
 * any parse error, any tokenEnv anomaly, or any root-locked key in a non-root
 * config is a finding. Never trusts the routing manifest — an unreferenced staged
 * config dir is swept the same as a referenced one.
 */
export async function verifyConfig(
  root: string,
  options: { expected?: string } = {},
): Promise<VerifyResult> {
  const findings: VerifyFinding[] = [];
  const rootConfigDir = path.join(root, CONFIG_DIRNAME);
  const rel = (file: string): string => path.relative(root, file) || path.basename(file);

  const files = await discoverConfigFiles(root);
  const tokenEnvOccurrences: Array<{ file: string; value: string; isRoot: boolean }> = [];

  for (const file of files) {
    const isRoot = path.dirname(file) === rootConfigDir;

    let parsed: unknown;
    try {
      const raw = await readFile(file, "utf8");
      parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
    } catch (error) {
      findings.push({ file: rel(file), problem: `failed to parse: ${errorMessage(error)}` });
      continue;
    }
    const object = asObject(parsed);
    if (!object) {
      findings.push({ file: rel(file), problem: "config is not a JSON object" });
      continue;
    }

    const facts = extractFacts(file, object);
    if (facts.tokenEnv !== undefined) {
      tokenEnvOccurrences.push({ file: rel(file), value: facts.tokenEnv, isRoot });
    }

    if (!isRoot) {
      const locked: string[] = [];
      if (facts.declaresAuth) {
        locked.push("auth");
      }
      if (facts.declaresBreakGlass) {
        locked.push("breakGlass");
      }
      if (facts.declaresCommentTag) {
        locked.push("commentTag");
      }
      if (locked.length > 0) {
        findings.push({
          file: rel(file),
          problem: `non-root config declares ${locked.join(", ")} — root-locked; only the root .expo-code-review config may set ${locked.length > 1 ? "them" : "it"}`,
        });
      }
    }
  }

  // tokenEnv must appear at most once, only in a root-owned file.
  for (const occurrence of tokenEnvOccurrences.filter((o) => !o.isRoot)) {
    findings.push({
      file: occurrence.file,
      problem: `tokenEnv "${occurrence.value}" is declared outside the root config; only a root-owned config.jsonc/config.json or routing.jsonc may name the forwarded credential`,
    });
  }
  if (tokenEnvOccurrences.length > 1) {
    findings.push({
      file: tokenEnvOccurrences.map((o) => o.file).join(", "),
      problem: `tokenEnv is declared in ${tokenEnvOccurrences.length} files; it must appear exactly once, in a root-owned config`,
    });
  }

  // With an expectation set, exactly one root occurrence equal to it is required.
  const expected = options.expected;
  if (expected) {
    const rootOccurrences = tokenEnvOccurrences.filter((o) => o.isRoot);
    if (rootOccurrences.length === 0) {
      findings.push({
        file: path.join(CONFIG_DIRNAME, "config.jsonc"),
        problem: `no tokenEnv found, but an expected value "${expected}" is set — exactly one root-owned tokenEnv is required`,
      });
    } else {
      for (const occurrence of rootOccurrences) {
        if (occurrence.value !== expected) {
          findings.push({
            file: occurrence.file,
            problem: `tokenEnv "${occurrence.value}" != expected "${expected}" — a PR must not repoint which secret is forwarded to the model provider`,
          });
        }
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

/** CLI wrapper: parse flags, run the sweep, print, and set the exit code. */
export async function verifyConfigCommand(argv: string[] = []): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  const json = argv.includes("--json");
  let expected = process.env.ECR_EXPECTED_TOKEN_ENV || undefined;
  const expectedIdx = argv.indexOf("--expected");
  if (expectedIdx >= 0) {
    const value = argv[expectedIdx + 1];
    if (!value || value.startsWith("-")) {
      process.stderr.write("--expected requires a value (the env var name)\n");
      process.exitCode = 2;
      return;
    }
    expected = value;
  }

  const root = (await repoRoot()) ?? process.cwd();
  const result = await verifyConfig(root, { expected });

  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `verify-config: OK — ${expected ? `tokenEnv locked to "${expected}"` : "no tokenEnv anomalies"}; no non-root config declares root-locked keys.\n`,
    );
  } else {
    for (const finding of result.findings) {
      process.stderr.write(`::error::${finding.problem} (${finding.file})\n`);
    }
    process.stderr.write(
      `verify-config: refusing to run — ${result.findings.length} problem(s) above.\n`,
    );
  }

  process.exitCode = result.ok ? 0 : 1;
}
