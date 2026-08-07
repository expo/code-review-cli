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
- `src/research-mcp/` + `research/` — bundled read-only documentation MCP,
  trusted networked indexer, and built-in source catalog.
- `src/sources/` — where the diff comes from (`local-git`, `github-pr`).
- `src/reporters/` — where findings go (`terminal`, `github`).
- `src/config/` — zod schema + loader for `.expo-code-review/config.jsonc`;
  `routing.ts` parses the monorepo `routing.jsonc` manifest and assigns changed
  files to scopes (last-match-wins).
- `templates/` — the files `ecr init` scaffolds into adopting repos. Keep them in
  sync with the code (config options, workflow steps, auth defaults).
- `src/__tests__/` — `bun test` unit tests, one file per module.

## LLP

- Design docs live in `llp/`; LLP 0000 is the root — read it first for
  orientation.
- Before changing an area, read the LLPs that cover it.
- Implementing a non-obvious decision an LLP documents? Add a ref:
  `// @ref LLP NNNN#anchor — short gloss`.
- Update the LLP or the ref in the same commit as the design/code change that
  makes it stale — don't let them drift apart.
- Code that contradicts its referenced LLP is a signal: flag the conflict,
  don't silently "fix" either side.
- `./ref-check` (`bun run llp:check`) validates refs and metadata; CI runs it
  on every push and PR.
- `ecr ref-check` validates the SAME `@ref` grammar inside a repo's
  `.expo-code-review/` setup (see LLP 0012). The two checkers share the grammar:
  a change to target kinds, the `<placeholder>` rule, or the glob dialect must
  land in `./ref-check` and `src/core/config-refs.ts` together.

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
- **`opencode-ai` and `@opencode-ai/sdk` are one unit — pinned EXACTLY, bumped
  together.** The SDK spawns the CLI (`launch("opencode")`), so the two are a matched
  pair: a CLI older than the SDK rejects model ids the SDK accepts. Exact pins stop an
  `npx` install in CI from floating one ahead of the other, and `startOpencode`
  prepends our own `node_modules/.bin` to `PATH` so a machine's global install can't
  shadow the pinned one. `ecr doctor` prints the version actually in use. (The SDK's
  spawn is a bare `launch("opencode")`; on POSIX — the supported platform — the cwd is
  never searched, so a PR-committed shim can't hijack it. The direct-spawn `opencode`
  callers we own, `ecr doctor`/`ecr setup-auth`, are hardened via `resolveOpencodeCli`.)
- **Fail fast and name the fix for setup errors.** A bad model id or credential hits
  every pass identically, so it must throw once, before any pass runs, with the fix in
  the message (`assertModelsResolvable`, `checkOauthTokenShape`) — never as N
  indistinguishable coverage gaps discovered after spending the run's budget.

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
