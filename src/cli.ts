#!/usr/bin/env node
import { ciCommand } from "./commands/ci.js";
import { dismissCommand } from "./commands/dismiss.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { reviewCommand } from "./commands/review.js";
import { verifyConfigCommand } from "./commands/verify-config.js";

const USAGE = `expo-code-review (ecr) — config-driven AI code reviewer

Usage:
  ecr review [options]   Review local changes (default). See \`ecr review --help\`.
  ecr ci                 Review the current PR and post a comment (GitHub Actions).
  ecr dismiss --pr <n> <id...>     Hide a finding on a PR (see \`ecr dismiss --help\`).
  ecr undismiss --pr <n> <id...>   Restore a dismissed finding.
  ecr init [--monorepo] [--scope <dir>]   Scaffold .expo-code-review/ in this repo.
  ecr doctor [--list-scopes]   Check environment, config, credentials, and scopes.
  ecr verify-config [--expected <env>] [--json]   Refuse to run if a config could redirect the credential (CI guard).

Agents live in each repo under .expo-code-review/. This CLI is the engine.

Monorepos: .expo-code-review/routing.jsonc routes paths to per-team scopes (see README).
`;

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;

  if (sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(USAGE);
    return;
  }

  // No subcommand (or a leading flag) defaults to `review`.
  if (!sub || sub.startsWith("-")) {
    await reviewCommand(process.argv.slice(2));
    return;
  }

  switch (sub) {
    case "review":
      await reviewCommand(rest);
      break;
    case "ci":
      await ciCommand(rest);
      break;
    case "dismiss":
      await dismissCommand(rest, "add");
      break;
    case "undismiss":
      await dismissCommand(rest, "remove");
      break;
    case "init":
      await initCommand(rest);
      break;
    case "doctor":
      await doctorCommand(rest);
      break;
    case "verify-config":
      await verifyConfigCommand(rest);
      break;
    default:
      process.stderr.write(`Unknown command: ${sub}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

void main();
