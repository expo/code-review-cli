# Plan: trusted configuration by default

## Status

Proposed security hardening for the next release of `@expo/code-review-cli`.

The immediate workflow mitigation is straightforward: check out the pull
request's base SHA before invoking `ecr ci`. Version 0.5.2 already loads review
configuration before materializing the PR head for source reads, so a correctly
written workflow can keep configuration trusted while still reviewing the PR's
actual files.

That is not a sufficient product default. A security property this important
must be enforced by the CLI rather than depending on every adopter writing the
same workflow correctly.

## Problem

In a `pull_request` workflow, the default checkout is the PR merge ref. ECR then
loads the following security-sensitive inputs from that checkout:

- root and routed `config.jsonc` files;
- provider, auth mode, `tokenEnv`, model, budget, and trigger policy;
- reviewer, shared, and coordinator prompts;
- routing, enforced agents, break-glass policy, and comment tags.

A same-repository PR can therefore change the reviewer that evaluates that PR
while the process has a model credential and a comment-capable GitHub token.
`ECR_EXPECTED_TOKEN_ENV` and `ecr verify-config` constrain credential names, but
they do not make the rest of a PR-controlled configuration trustworthy.

## Security invariant

For a GitHub PR review:

> Review policy and executable reviewer configuration come from a trusted base
> commit or an explicit operator-owned directory. The PR head is untrusted data
> used only for its diff and source contents.

This includes every root and scope config, all prompt markdown, routing, model
selection, auth/provider mapping, break-glass behavior, and comment identity.
A config change in a PR becomes active only after it merges.

Failure to resolve or materialize the trusted config must fail closed. CI must
not silently fall back to the current checkout.

## Desired default behavior

1. `ecr ci` resolves the PR's immutable base and head commit OIDs through the
   GitHub API.
2. It materializes the base commit into a temporary trusted-config root.
3. It loads and validates all ECR configuration and prompts from that root.
4. It fetches the diff through GitHub and materializes the PR head separately
   for source reads and finding verification.
5. It starts the model runtime without loading ambient configuration from the
   untrusted PR-head directory.
6. It removes both temporary trees on every success and failure path.

An explicit operator-owned `--config-dir` / `ECR_CONFIG_DIR` remains supported
and takes precedence. In CI, a relative override is resolved beneath the trusted
base root; an absolute override must be explicitly allowed and documented as an
operator trust decision.

## Implementation

### 1. Immediate workflow containment

Update all scaffolded auto-review workflows to:

```yaml
- uses: actions/checkout@<full-sha> # pinned release
  with:
    ref: ${{ github.event.pull_request.base.sha }}
    fetch-depth: 1
    persist-credentials: false
```

Keep the published ECR package pinned to an exact version. Run
`ecr verify-config` against this trusted checkout before `ecr ci`.

The command workflow already uses the base ref; align comments and tests so the
auto and command workflows state the same trust model.

### 2. Resolve immutable PR refs

Extend `GitHubPRSource.getMetadata()` to request immutable base/head OIDs in
addition to names. Treat missing OIDs, a repository mismatch, or an unexpected
base repository as a setup error.

Add a small ref type rather than passing branch names through security-sensitive
code:

```ts
interface PullRequestRefs {
  base: { repo: string; oid: string };
  head: { repo: string; oid: string };
}
```

Use argument arrays for every `git`/`gh` call and validate OIDs as full
hexadecimal commit hashes before passing them to Git.

### 3. Materialize a trusted config root

Add a `prepareTrustedConfigRootAsync()` path to the GitHub PR source:

- fetch the base OID from the base repository's HTTPS URL without credentials
  embedded in Git configuration;
- create a detached temporary worktree or archive;
- return its directory plus an idempotent cleanup callback;
- never fall back to `process.cwd()` in CI.

Local review modes may retain their current checkout behavior because the user
is the trust principal. `ecr ci`, and `review --pr` when posting with a token,
should default to base-ref trust.

### 4. Separate config root from source root

Change config loading APIs to receive an explicit `configRoot` instead of
implicitly reading from `cwd`. This must cover:

- `loadReviewConfig`;
- `loadRoutingManifest`;
- `loadScopeConfig`;
- agent discovery and frontmatter;
- `shared.md` and coordinator prompt loading;
- `verify-config`;
- run-log and comment-tag initialization.

Continue passing a distinct PR-head `sourceRoot` to the read/grep and finding
verification paths. Do not use `process.chdir()` as the mechanism that decides
which tree is trusted.

### 5. Isolate the model runtime from PR-owned ambient configuration

Today the OpenCode server starts after ECR enters the PR-head worktree. Verify
whether that causes OpenCode, Claude-compatible instruction files, plugins,
hooks, MCP configuration, or repository settings from the PR head to load
implicitly.

The target behavior is:

- start the model runtime from an empty ECR-owned runtime directory;
- provide explicit read-only access to the PR-head source root;
- pass ECR's trusted prompts and generated OpenCode configuration explicitly;
- disable project plugin, hook, MCP, and auto-discovery paths that are not part
  of the trusted ECR configuration;
- permit writes only to ECR-owned run directories.

If OpenCode cannot provide those guarantees, implement ECR-owned read/grep tools
over `sourceRoot` and do not expose the PR tree as the runtime working directory.

### 6. Make verification trust-aware

`ecr verify-config` should accept the same resolved trusted config root as
`ecr ci`. In GitHub CI mode it should report both refs:

```text
config: <base-repo>@<base-oid>
source: <head-repo>@<head-oid>
```

The existing repo-wide sweep and `ECR_EXPECTED_TOKEN_ENV` lock remain useful
defense in depth, but they apply to the trusted tree. PR-head ECR config files
may be reported as pending configuration changes; they must not affect the
current run.

### 7. CLI and compatibility surface

Prefer a safe default with a conspicuous escape hatch:

- `ecr ci`: trusted base config, always;
- `ecr review --pr`: trusted base config by default;
- local diff/staged review: current checkout config;
- `--config-dir`: explicit operator-owned override;
- optional `--unsafe-config-from-head`: temporary compatibility escape hatch,
  rejected unless explicitly supplied and never scaffolded.

Do not offer an environment variable that silently changes CI back to PR-head
trust. If compatibility requires one release of opt-out behavior, print a
security warning and remove it on a scheduled major/minor boundary.

## Tests

Add end-to-end fixtures where a same-repository PR changes each of the following:

- `auth.provider`, `auth.mode`, and `auth.tokenEnv`;
- root and scope models;
- agent, shared, and coordinator prompts;
- routing and enforced-agent policy;
- trigger, break-glass, noise, budget, and comment tag;
- an unreferenced nested `.expo-code-review/config.jsonc`;
- `opencode.json`, `AGENTS.md`, `.claude/settings.json`, plugins, hooks, and MCP
  definitions in the PR head.

Assert that:

- the run uses every relevant value from the base commit;
- the PR-head source contents and line numbers are still reviewed;
- no PR-owned hook, plugin, MCP server, or command executes;
- a config-only PR is reviewed with the previous config and activates only
  after merge;
- missing/unfetchable base configuration fails closed with one actionable
  terminal comment;
- fork PRs, renamed branches, force-pushes, and deleted heads use immutable OIDs;
- fetch URLs and `.git/config` never contain `GH_TOKEN`;
- temporary config/source/runtime directories are removed on all failure paths.

Unit tests should make `configRoot`, `sourceRoot`, and `runtimeRoot` visibly
different directories so accidental `cwd` coupling fails immediately.

## Rollout

1. Ship the base-SHA workflow template change immediately.
2. Implement explicit root separation and red tests.
3. Add runtime ambient-config isolation.
4. Release the CLI enforcement in a new minor version.
5. Update `ecr init --with-workflow`, README security documentation, `doctor`,
   and migration notes.
6. Run the release against a PR that maliciously changes every configuration
   surface above before recommending adoption.

## Completion criteria

This work is complete when an adopter can use the scaffolded workflow—or a
minimal custom workflow calling pinned `ecr ci`—and a same-repository PR cannot
change the model credential destination, reviewer policy, prompts, tools, or
runtime extensions used to review itself.
