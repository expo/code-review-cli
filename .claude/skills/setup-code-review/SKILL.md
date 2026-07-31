---
name: setup-code-review
description: Install and configure @expo/code-review-cli (ecr) in any repo — detect monorepo shape, mine GitHub history for review hotspots and past security issues, research best practices per technology, then generate the full .expo-code-review/ setup (config, agents, coordinator, shared, routing) via a large dynamic workflow. Use when the user wants to set up, install, or reconfigure AI code review in a repository.
---

# Setup @expo/code-review-cli in a repo

You are installing a config-driven multi-agent AI code reviewer into the current repo.
The CLI is the engine; the repo supplies everything under `.expo-code-review/`. Your job
is to produce a repo-*specific* setup: agents that know this codebase's technologies,
its historical problem areas, and its conventions — not generic templates.

**Read `ecr-reference.md` (next to this file) FIRST and keep it loaded.** It is the
authoritative reference for every command, config field, auth shape, routing rule,
agent-file format, and runtime constraint. Never invent a flag or field: if it is not
in the reference, verify against the CLI source before using it.

This task is a standing opt-in for the Workflow tool: run the phases below as dynamic
workflows without asking permission for the orchestration itself. Repo writes still go
through a worktree per normal discipline (writes to `.expo-code-review/`, `.github/`,
`CODEOWNERS` are repo modifications).

## Phase 0 — Preflight (inline, no workflow)

1. Confirm: git repo, repo root, default branch, `gh` authed (`gh auth status`), origin
   `owner/repo`.
2. If `.expo-code-review/` already exists: this is a RE-configuration. Read the existing
   config fully; preserve auth and commentTag unless the user asks otherwise; treat
   existing agents as candidates to improve, not overwrite blindly.
3. Note repo size (`git ls-files | wc -l`) to scale the discovery fan-out.

## Phase 1 — Discovery workflow (parallel, read-only)

Launch ONE Workflow with parallel explorers. All are read-only; no worktree needed yet.
Each agent returns a dense structured report (give each an explicit output contract and
a token cap). Scale: small repo → merge adjacent lenses; large monorepo → all of them.

- **repo-shape**: monorepo or not. Evidence: package.json `workspaces`,
  `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, go.work, Cargo
  workspace, multiple top-level service dirs, CODEOWNERS structure. If monorepo:
  propose scope candidates as `{name, paths[], configDir, owningTeam?}` — team- or
  deployable-aligned subtrees, not one scope per package. Remember routing is
  last-match-wins with a `**/*` catch-all first.
- **tech-stack**: languages, frameworks, SDKs, build tooling, test frameworks, infra
  (Docker/Terraform/CI), per subtree if monorepo. Output: ranked list with where each
  lives — this drives the best-practices fan-out and the agent roster.
- **conventions**: CLAUDE.md / AGENTS.md / CONTRIBUTING / lint+formatter configs /
  tsconfig strictness / CI checks. Output: what is ALREADY enforced by tooling (agents
  must NOT re-flag it) and written conventions agents should enforce.
- **review-history**: mine merged PRs via `gh` (`gh pr list --state merged`, review
  comments via `gh api repos/{owner}/{repo}/pulls/comments --paginate` on a sample).
  Output: recurring reviewer themes, files/dirs drawing the most review comments,
  frequent rework areas (`git log` churn on top). These become agent "What to flag"
  bullets grounded in real history.
- **security-history**: past security fixes (`git log --grep` for security/CVE/vuln/
  injection/sanitize/secret/auth), `gh api repos/{owner}/{repo}/security-advisories`,
  dependabot alerts if readable, hotspots: auth code, input parsing, secrets handling,
  SQL/shell/HTML construction. Output: concrete past incident classes + the sensitive
  surfaces of THIS repo — the security agent is built from this.
- **hotspots** (large repos only): top-churn files (`git log --format= --name-only |
  sort | uniq -c`), bug-fix-dense dirs (`--grep fix`), TODO/FIXME density. Output:
  areas deserving reviewer attention weighting.

Barrier after this phase: the synthesis and every later decision needs all reports.

## Phase 2 — Best-practices fan-out (parallel, web research)

For each MAJOR technology from tech-stack (cap at the ones that meaningfully appear in
diffs — not every transitive tool), spawn one research agent: current best practices,
recent breaking changes, and the top review-worthy pitfalls for that technology,
favoring official docs and changelogs over training memory. Output contract: max ~15
bullets phrased as *reviewable rules* ("flag X when Y"), each tagged flag/anti-flag.
These feed directly into per-tech agent bodies. Skip this phase only if the repo
touches no external technology.

## Phase 3 — Decisions (main loop, ask the user)

Synthesize Phases 1–2, then ask the user (one AskUserQuestion, together):

1. **Engine & auth** — see the decision table in `ecr-reference.md` §4. Options:
   - Claude Code CLI on a Max/Team subscription → `engine` selected by `anthropic/…`
     model ids; token via `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`.
   - OpenCode + OpenAI API key (scaffolded default) → `OPENAI_API_KEY`.
   - Codex/ChatGPT subscription OAuth → `CODEX_OAUTH_ACCESS_TOKEN`.
   - Mixed (subscription default + metered pro-tier key) — recommended when they have
     a Codex subscription.
   Recommend based on what credentials the user already has (check `claude` login /
   existing env vars before asking; put the detected option first).
2. **Monorepo scopes** — if monorepo: propose the scope plan from repo-shape (names,
   paths, owners); confirm or trim. Single-repo: skip.
3. **Trigger policy** — `review.trigger`: `all` PRs vs `label` opt-in (recommend
   `label` for high-traffic repos, `all` for small ones).

Do not ask about things discovery already answered.

## Phase 4 — Scaffold + generate (worktree, then a generation workflow)

Enter a worktree (branch e.g. `<repo>-code-review-setup`). Then:

1. **Scaffold with the real CLI — never hand-create the tree**:
   `npx @expo/code-review-cli init` (add `--monorepo` if scoping; then
   `npx @expo/code-review-cli init --scope <dir>` per scope; `--no-workflow` only if
   the repo can't take a GitHub workflow). The scaffold gives correct file shapes,
   workflows, and `.gitignore` entries; your job is to REWRITE the contents.
2. **Write root `config.jsonc`** per the Phase 3 decisions: `model`, `auth` (root-only,
   exact shapes from reference §4), `review.trigger`/`label`, `noise.additionalIgnores`
   for this repo's generated paths, `chunk` overrides only if discovery justifies them.
   Scope configs: NO `auth`/`breakGlass`/`commentTag` (loader rejects them).
3. **Generation workflow** — fan out one writer agent per file, all fed the relevant
   discovery + best-practices material plus the authoring rules from reference §6:
   - `shared.md`: cross-cutting scope rules, severity definitions (canonical HERE
     only), the JSON finding contract, evidence rules (one verbatim contiguous line —
     unmatched evidence sends the finding to an adversarial verifier that drops it
     if refuted), prompt-
     injection defense, repo-specific global context (build system, conventions).
   - `agents/*.md`: a roster of 3–6 per scope, typically: `security` (alwaysRun: true,
     built from security-history + sensitive surfaces), `correctness`, one or two
     per-tech agents from Phase 2 (only for techs with real diff volume), optionally a
     `consistency`/conventions agent from the conventions report. Each file: flat
     frontmatter (`description`, optional `alwaysRun`/`model`), `## What to flag` with
     repo-specific bullets citing real paths/patterns, `## What NOT to flag` (include
     everything the linters already enforce), closing restraint line. Never restate
     severity/JSON format in agent files.
   - `coordinator.md`: keep the template's dedupe/re-judge/decision rubric; add
     repo-specific severity guidance only if security-history warrants it.
   - Monorepo: `routing.jsonc` — broad scopes first, specific last, `**/*` catch-all,
     `defaults.enforceAgents: ["security"]`, `defaults.auth` as the lock.
   - Parallel writers touch disjoint files, so no per-agent worktrees needed.
4. **CI wiring**: keep the scaffolded workflows; list for the user the repo
   secrets/variables to set (reference §4: the tokenEnv secret, and repo variable
   `ECR_EXPECTED_TOKEN_ENV` when not `OPENAI_API_KEY`). Suggest CODEOWNERS lines:
   `/.expo-code-review/routing.jsonc @infra` and per-scope dirs to their teams.

## Phase 5 — Verify (checker, separate agent)

1. Run `npx @expo/code-review-cli doctor` (and `doctor --list-scopes` for monorepos)
   in the worktree; fix everything it flags. Credentials may legitimately be missing
   locally — report that as "user must run `ecr setup-auth`", not as a failure.
2. Spawn a checker agent (not self-review) that audits every generated file against
   `ecr-reference.md` §6–7: frontmatter is flat scalars, mandatory sections present,
   no severity/JSON restated in agents, scope configs contain no locked fields,
   routing globs cover everything, agent bullets are repo-specific (reject generic
   filler). Loop maker←checker until it passes.
3. If credentials are available, do one real trial: `npx @expo/code-review-cli review
   --base <default-branch>` on a recent small diff (or `review --pr <n>` preview,
   never `--post`). Judge finding quality; tune agents once if noisy.

## Phase 6 — Report

Summarize for the user: what was installed (tree), the engine/auth chosen and the
exact secrets/variables to create, the agent roster with one line each on what makes
it specific to this repo, scope table if monorepo, and the remaining manual steps
(`ecr setup-auth`, set CI secrets, merge the PR). Offer to open the PR via the normal
worktree flow but don't push without being asked.
