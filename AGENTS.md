# Agent guide

`@expo/code-review-cli` (`ecr`) is a config-driven AI code reviewer engine.
Adopting repos scaffold `.expo-code-review/` (agent prompts + config) and a CI
workflow; the CLI diffs a PR, fans the diff out to reviewer agents via OpenCode,
verifies their findings, and posts one updating PR comment.

## Layout

- `src/cli.ts` — entry point; dispatches to `src/commands/*` (`init`, `review`,
  `ci`, `doctor`, `dismiss`).
- `src/core/` — engine: diffing/chunking, prompt assembly, OpenCode server,
  finding verification, comment rendering, auth.
- `src/sources/` — where the diff comes from (`local-git`, `github-pr`).
- `src/reporters/` — where findings go (`terminal`, `github`).
- `src/config/` — zod schema + loader for `.expo-code-review/config.jsonc`;
  `routing.ts` parses the monorepo `routing.jsonc` manifest and assigns changed
  files to scopes (last-match-wins).
- `templates/` — the files `ecr init` scaffolds into adopting repos. Keep them in
  sync with the code (config options, workflow steps, auth defaults).
- `src/__tests__/` — `bun test` unit tests, one file per module.

## Conventions

- TypeScript, ESM with NodeNext resolution: relative imports use the `.js`
  suffix.
- Commands: `USAGE` string, handle `-h`/`--help` first, report errors to stderr
  via `errorMessage(error)` (`src/core/util.ts`), set `process.exitCode` (2 for
  usage/failure) — never call `process.exit()`.
- Child processes always go through `src/core/exec.ts` (`execFile` with argument
  arrays, no shell).
- New config options must update `src/config/schema.ts`, `src/config/load.ts`,
  and `templates/config.jsonc` together.
- Core paths must work in both local mode (`local-git` + terminal reporter) and
  CI mode (`github-pr` + GitHub reporter).
- `ecr ci` must never fail a PR's checks — reviewer errors degrade gracefully.
- Scope configs never carry `auth`/`breakGlass` — those are root-only, enforced in
  the schema (`ScopeReviewConfigSchema`), the loader (`loadAuthFromRoot`), and the CI
  guard. With no `routing.jsonc`, behavior is byte-identical to single-config mode.

## Security invariants

- PR content (diffs, paths, titles, config in the reviewed repo) is untrusted.
  Prompt interpolation goes through `sanitizeUntrusted`/boundary markers in
  `src/core/prompts.ts`.
- Model output is untrusted: schema-validate it, and trust `file`/`line`/
  `evidence` only after verification (`src/core/verify.ts`).
- The model credential (`auth.tokenEnv`) must never reach logs, error messages,
  or `.expo-code-review/.runs/`. `FORBIDDEN_TOKEN_ENVS` in `src/core/auth.ts`
  stops configs from exfiltrating non-provider secrets — don't weaken it.

## Workflow

- `bun run dev` runs the CLI from source; `bun test` runs unit tests;
  `bun run typecheck` type-checks.
- Releases: `bun run release` (see `scripts/release.sh`).
