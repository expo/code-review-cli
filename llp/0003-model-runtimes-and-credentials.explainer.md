# LLP 0003: Model Runtimes, Subprocess Hardening, and Credentials

**Type:** Explainer
**Status:** Active
**Systems:** Runtime, Security
**Author:** Philippe Loulidi / Claude
**Date:** 2026-07-30
**Related:** [LLP 0001 Trust Model and Security Principles](0001-trust-model.principles.md), [LLP 0002 Review Engine Pipeline](0002-review-engine-pipeline.explainer.md), [LLP 0006 Config Schema, Loading, and Routing](0006-config-schema-loading-routing.explainer.md)

This document explains the runtime layer that turns a resolved review config into
actual model calls: which engine each agent runs on, how the two engines are kept
apart at the type and process level, how child processes are spawned and contained,
how credentials are resolved and forwarded without leaking, and how the five distinct
failure classes are told apart so a wedged pass never burns a whole run's budget.
Every load-bearing claim below was checked against the source and is tagged
[observed]; there are no `[inferred]` claims. The subsystem lives in
`src/core/opencode.ts`, `claude-code.ts`, `exec.ts`, `auth.ts`, `throttle.ts`, and
`tools.ts`.

## Two Engines, Per-Agent Dispatch

There are two model engines: OpenCode (`opencode.ts`) and the Claude Code CLI
(`claude-code.ts`). Which one an agent uses is a pure function of that agent's
resolved model id — no run-level flag, no auth-mode switch. `engineForModel` takes the
provider prefix before the first `/`: `anthropic/…` goes to the Claude Code CLI,
everything else to OpenCode ([observed] `claude-code.ts:170-174`). This exists because
OpenCode has no Anthropic subscription OAuth support, so reviews on a Claude Max/Team
plan were impossible until the CLI engine was added ([observed] commit `93aaf30` body).
The retired anthropic-via-OpenCode `x-api-key` path no longer exists.

Because engine selection is per-model, **one run can drive both engines at once** — an
`anthropic/…` reviewer and an `openai/…` reviewer in the same config each go to their
own engine, and the inference converges to a single engine automatically when every
model is identical (e.g. under `REVIEWER_MODEL`), so no run-level convergence code is
needed ([observed] `claude-code.ts:176-221` `buildEngineMap`). The engine map is built
from the run's **selected** agent subset for the reviewer roles, while the fixed roles
(cross-cutting, verifier, coordinator) stay on the full roster; a run whose selected
passes never touch Claude therefore never preflights a missing Claude CLI or token for
nothing ([observed] `claude-code.ts:185-191`).

The two engine modules would form a static import cycle: `claude-code.ts` imports
concrete helpers and constants from `opencode.ts`, and `opencode.ts` needs to reach
`claude-code.ts` to dispatch. This is resolved by an asymmetric seam. `opencode.ts`
imports only `claude-code.ts`'s **types** statically (`import type`, erased at compile
time, so no runtime edge) and reaches the Claude engine at runtime exclusively via
dynamic `import("./claude-code.js")` inside the dispatch callers
([observed] `opencode.ts:9-12`, and dynamic imports at `opencode.ts:488,754,1020`).
`resolveEngineDispatch` is the switch: it routes an agent to `opencode` or returns the
matching `ClaudeCodeHandle`, failing loudly if a mixed-run handle was assembled without
its `.claude` carrier rather than letting an `undefined` cast crash deep inside
`runClaudePrompt` ([observed] `opencode.ts:30-55`).

## OpenCode Server Lifecycle

The OpenCode engine starts an in-process server and talks to it over HTTP. Several
lifecycle choices are load-bearing.

**Port 0, not the SDK default.** The server is started on port 0 (OS-assigned free
port), not the SDK's fixed default of 4096, because a developer's own already-running
`opencode` session on 4096 would otherwise make every local run die with an opaque
`ServeError` ([observed] `opencode.ts:319-326`; commit `14b32a0`).

**The CLI and SDK are a pinned pair.** `opencode-ai` and `@opencode-ai/sdk` are one
unit — pinned exactly and bumped together ([observed] `AGENTS.md:54`). A mismatch (a
1.18.1 CLI against a 1.18.4 SDK) surfaced as a misleading `ProviderModelNotFoundError`.
The SDK spawns the server with a bare `launch("opencode")`, so `startOpencode` prepends
`ecr`'s own `node_modules/.bin` (resolved via `require.resolve("opencode-ai/package.json")`,
relative to this module and not to cwd) to `PATH` so the bundled, version-matched
binary wins over any global install ([observed] `opencode.ts:237-318`,
`bundledOpencodeBinDir`).

**Preflight the model ids once.** Every configured model is checked against the running
server's actual provider/model list before any pass runs (`assertModelsResolvable`),
failing once with a naming fix instead of reporting N indistinguishable "pass failed"
gaps after burning the budget ([observed] `opencode.ts:475-508`; `AGENTS.md:63-66`). The
error distinguishes three reasons: a model that a supplied-credential provider still
does not offer means **credential refused**, not **model not found**; a bad OAuth token
makes OpenCode silently drop the whole provider from its list, so without this every id
reports "model not found" and nothing mentions credentials ([observed]
`opencode.ts:337-348` `UnknownModel.reason`, `427-473` `formatUnknownModels`; commit
`14b32a0`).

**Register the cross-cutting agent explicitly.** The single combined cross-file pass
must be registered here with a restricted, explicit tool set (`read` + `grep`, no
`glob`/`list`). Omitting the registration makes OpenCode fall back to a default agent
with full tools that crawls the whole repo — the reason the cross-file pass used to
wander for its entire time budget. Directory crawling is exactly what made it wander
into unrelated packages, so `glob`/`list` are deliberately withheld ([observed]
`opencode.ts:125-134`).

**One accepted residual.** The `PATH`-prepend trick forces the pinned binary, but it
does not harden the SDK's own bare `launch("opencode")` spawn against a Windows
cwd-search hijack. Reimplementing the SDK's server bootstrap to inject an absolute path
was explicitly rejected as not worth the maintenance burden: the deployment target is
POSIX, where `execvp` never searches cwd. This is a knowingly accepted residual, not an
oversight, and must not be silently reintroduced as a "fix" ([observed]
`opencode.ts:305-314`).

## Claude Code CLI Containment

The Claude Code engine runs each review pass as a single stateless
`claude -p --output-format stream-json --verbose` subprocess fed the task on stdin.
The JSONL stream makes tool activity observable while the pass runs instead of leaving
only a periodic heartbeat until the final result. The incremental decoder emits only
bounded lifecycle metadata and read-tool names with confined repo-relative targets;
raw assistant text, tool results, grep patterns, and attempted host paths never reach
the progress or error logs because model output is untrusted and may contain source
secrets or terminal/log-injection payloads. If a stream ends without a final result,
or its error result has no explicit message, parsing returns a fixed diagnostic rather
than falling back to the raw JSONL transcript. The fixed diagnostic carries the child
exit code and may derive an actionable, fixed category from stderr only when no stream
was emitted (rejected flags, authentication, or launch failure); arbitrary stderr is
never copied into logs, and only an explicit final-result error message reaches
provider-error classification. Every task-specific progress line is tagged with the
stable agent bucket by the review pipeline, so concurrent passes remain attributable
[observed] `claude-code.ts` `claudeExitDiagnostic`/`runClaudePrompt`, `review.ts`
`formatAgentActivity`/`taskProgress`; tests in
`claude-code.test.ts` and `review-internals.test.ts`. The argv and child environment
are built to keep an untrusted PR (the review input) from turning that subprocess into
code execution or credential exfiltration.

Every production structured-output parser carries a draft-07 JSON Schema generated
from the same Zod contract used at the local trust boundary. The Claude runtime passes
that schema through `--json-schema`; Claude Code validates the final `StructuredOutput`
tool call and re-prompts inside the original session when a required field or type is
wrong. The validated `structured_output` object is then serialized through the local
Zod parser again — provider validation improves reliability but never replaces local
validation. If Claude exhausts its in-session structured-output retries (or claims
success without returning `structured_output`), the runtime makes one clean-process
attempt and accounts for both attempts; it never accepts unvalidated fallback text
[observed] `schema.ts` `structuredParser`; `opencode.ts` `promptAndParse`;
`claude-code.ts` `buildClaudeArgs`, `parseClaudeResult`, `runClaudePrompt`,
`claudeCodePromptAndParse`.

**Flags.** `--safe-mode` disables CLAUDE.md/hooks/MCP/plugins while keeping OAuth;
`--bare` is deliberately **not** used because bare mode ignores
`CLAUDE_CODE_OAUTH_TOKEN` and keychain OAuth and would break subscription auth. Also
`--strict-mcp-config` and `--permission-mode dontAsk` ([observed]
`claude-code.ts:241-321` `buildClaudeArgs`).

**Tool scoping is counter-intuitive and load-bearing.** In this CLI an absent or empty
`--allowedTools` list default-**allows** reads; it does not default-deny. So two things
happen together: every **granted** read tool (`Read`/`Grep`/`Glob`) is path-scoped to
the review tree with a `//<cwd>/**` allow rule, and every read tool **not** granted is
denied explicitly **by name** via `--disallowedTools`. Assuming standard allow-list
semantics (unlisted = denied) would silently reopen every unscoped read tool — a bare
`Grep` no less than a bare `Read` would let an injected instruction read
`~/.claude/.credentials.json`, `.env*`, or SSH keys and emit them into a finding. This
was verified empirically against the installed CLI: in-tree reads succeed, out-of-tree
reads are denied by the unmatched-rule denial, and a withheld tool is denied by name
([observed] `claude-code.ts:241-321`; behavior verified against `claude 2.1.212`).
Write/exec/network tools (`Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`,
`WebSearch`, `Task`, …) are always denied for every pass regardless of role, via the
`ALWAYS_DENIED_TOOLS` enumeration. A deny **enumeration** is used rather than an
allow-only model because permission rules cannot fail closed for tools outside the read
set and a `*` deny breaks tool calling outright — both verified against `claude 2.1.212`.
The residual (a future CLI version shipping a new read-capable tool this list does not
name) is bounded by pinning the CLI version, so **the list must be revisited on every
pinned-version bump** ([observed] `claude-code.ts:86-111`).

**The env is an allowlist.** The child env is built from `CHILD_ENV_ALLOWLIST` (PATH,
HOME, locale, tmp, proxies, config dirs — what a CLI needs and nothing else), never a
copy of `process.env`. The review runs over untrusted PR content, so ambient secrets
(`GH_TOKEN`, CI tokens) must not exist in the child's environment at all. This also
strips ambient `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`: Anthropic's documented env
precedence lets an ambient API key override subscription OAuth, so leaving them out
forces the subscription to be used ([observed] `claude-code.ts:113-152, 785-790`).

**The symlink gap is closed upstream, not here.** The path-scoping allow rules do not,
by themselves, close the exfil path for a symlink committed inside the PR-head tree that
resolves outside it (e.g. `docs/notes.md -> ~/.claude/.credentials.json`): the CLI
permission check matches the literal in-tree path argument, but `Read`/`Grep` then
follow the symlink via `fs`. That gap is closed **upstream**, at read-root
materialization, which strips escaping symlinks (`removeEscapingSymlinks` in
`scrub.ts`, run by `prepareReadRootAsync`). Runs whose read root is the user's own
checkout (local diffs) skip the sweep — the user is the trust principal for their own
tree ([observed] `claude-code.ts:265-273`; see [LLP 0001](0001-trust-model.principles.md)
and the read-root materialization in `github-pr.ts`).

## Credential Resolution and Forwarding

`auth.ts` decides whether every in-use provider has a usable credential and stages the
credential for the run, guarding at each step against forwarding the wrong or a
forbidden secret. The threat is concrete: `auth.tokenEnv` names the env var whose value
becomes the provider credential, and that config is loaded from the repo — in the CI
auto-review path it can be PR-controlled.

**Two deny checks.** `FORBIDDEN_TOKEN_ENVS` refuses well-known unrelated secrets
(`GITHUB_TOKEN`, `AWS_*`, `NPM_TOKEN`, `SSH_PRIVATE_KEY`, …) so a PR cannot point
`tokenEnv` at one and have it shipped to the external model provider ([observed]
`auth.ts:36-58`; `AGENTS.md:75-77`). Separately, `ANTHROPIC_TOKEN_ENVS`
(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`) is kept **out** of the forbidden set
— an anthropic entry may legitimately name them — but is enforced by a cross-provider
ownership guard: a non-anthropic entry naming an Anthropic token env is refused.
Without that guard, `{provider:"openai", tokenEnv:"CLAUDE_CODE_OAUTH_TOKEN"}` passes
both other checks and forwards the Anthropic subscription token to a foreign provider
([observed] `auth.ts:20-34`; commit `93aaf30`).

**Scoped to providers in use.** Auth checks (`checkProviderAuth`) and credential
forwarding are scoped to only the providers a resolved model actually routes to. A dead
`auth` entry for an unused provider must neither block a run nor have its `tokenEnv`
forwarded — otherwise the shipped default `openai` api-key entry would spuriously block
an all-anthropic config, and forwarding a dead entry would reintroduce the exact
secret-forwarding the guard prevents ([observed] `auth.ts:378-392`).

**Isolated staging, engines kept separate.** `prepareAuth` writes all OAuth credentials
into one **isolated** OpenCode `auth.json` under a temp dir pointed to by
`XDG_DATA_HOME`, so a run's injected credentials never touch the developer's real
`auth.json` ([observed] `auth.ts:557-560`). It must run and complete before the server
starts, because it mutates env the spawned server reads — documented as a precondition,
not a convenience ([observed] `auth.ts:479-482`). Anthropic credentials **never** pass
through this path at all: anthropic is Claude-engine-only, so its credential is injected
per-invocation into the Claude CLI child env by `startClaudeCode`, keeping the two
engines' credential plumbing fully separate ([observed] `auth.ts:527-532`).

**A deliberate re-check at the forwarding site.** The deny-list check (`checkAuthEntry`)
is re-run at the Claude CLI credential-forwarding site inside `startClaudeCode`, in
addition to `prepareAuth`, because `REVIEWER_MODEL` bypasses `prepareAuth`/
`checkProviderAuth` entirely. `startClaudeCode`'s forward path is the one code path that
still forwards a config-named secret in that case, so without the re-check a config
could point `tokenEnv` at `GITHUB_TOKEN` or a foreign provider's key and ship it to
Anthropic as the bearer ([observed] `claude-code.ts:791-802`). `REVIEWER_MODEL` itself
is treated as a deliberate local-dev override that defers to OpenCode's ambient login,
not a hole, because it requires an explicit env var the CI workflow never sets
([observed] `auth.ts:498-504`).

**OAuth token shape drives staging.** `oauthAuthJsonEntry` stages an OpenAI OAuth
credential by what the token **is**: a JWT access token (three base64url segments) is
used as-is with its own `exp` claim and never refreshed; an opaque OpenAI value is
stored with `expires: 0` so OpenCode's codex plugin mints access tokens via its refresh
flow. Mixing the two breaks because refresh tokens are **single-use** — the
refresh-token-as-static-secret strategy died in production (every pass "Token refresh
failed: 401"; the shared copy was spent by its first use). The opaque strategy is only
safe when the run is the token's **sole** consumer; a value shared across runs or repos
dies on first rotation ([observed] `auth.ts:452-477`; commit `188f852`, euxy#8). The
hard-fail bar for `checkOauthTokenShape` is deliberately narrow — "this cannot be a
valid credential" (whitespace, absurd length, an API key in OAuth mode, a
provably-mangled `sk-` prefix), not "this looks odd" — because a false rejection blocks a
working setup, which is judged worse than the failure being prevented ([observed]
`auth.ts:88-101`).

## Subprocess Spawning Rules

`exec.ts` is the only sanctioned way to spawn a child process in the codebase — a hard
convention ([observed] `AGENTS.md:44-45`). It wraps `execFile`/`spawn` with array args and
no shell, and every module that spawns `git`/`gh`/`claude`/`opencode`/`taskkill` builds
on its trusted-path helpers.

**Trusted absolute paths, resolved from a trusted cwd.** No binary is ever spawned by a
bare command name while the process cwd may be the untrusted PR-head tree. Every spawn
resolves to an absolute path via `resolveOnPath`, and the lookup runs from `tmpdir()`,
never the process's own (possibly PR-tree) cwd. Windows `where` (and libuv for a bare
name) searches the current directory before PATH, so a PR-committed `claude.exe` at the
repo root would otherwise win the lookup and run with the engine's credentials in its
env; resolving from a host-controlled tmpdir means the in-tree shim is never even found
([observed] `exec.ts:348-364` `resolveOnPath`). `pathInside` is the backstop: any
resolution that lands inside the reviewed tree is refused ([observed]
`exec.ts:266-305` `resolveTrustedTool`, `366-373` `pathInside`;
`claude-code.ts:682-699` `resolveClaudeCli`; `opencode.ts:269-296` `resolveOpencodeCli`). The
one deliberate exception: a binary that comes from `ecr`'s **own** bundled
`node_modules` (via `require.resolve`, relative to the module, not cwd) skips the
in-tree refusal — it is trusted by construction, and `ecr`'s own `node_modules` commonly
sits under cwd when `ecr` reviews itself, which a blanket in-tree refusal would wrongly
reject and break the self-review CI run ([observed] `opencode.ts:282-289`).

**Process-group kill on abort.** `run` enforces its own timeout and kill, not `spawn`'s
native `timeout` option, because native timeout sends `killSignal` once, to the direct
child only, with no `SIGKILL` escalation — insufficient against a child that traps
`SIGTERM` or a shim wrapper (volta/mise/asdf) whose real work runs in a grandchild
([observed] `exec.ts:121-133` `runWithInput`). Detached children form their own process
group and are killed as a whole group (`process.kill(-pid, sig)` on POSIX,
`taskkill /T /F` on Windows), with a grace timer escalating to `SIGKILL`, so a review
aborted by Ctrl-C never orphans a credential-bearing `claude`/`opencode` child running
unbounded ([observed] `exec.ts:143-148, 162-189`). A timeout never throws synchronously: a killed
child resolves with `timedOut: true` in the result regardless of the `check` flag, so
callers get one consistent shape to distinguish "our own deadline fired" from a real
command failure ([observed] `exec.ts:71-87, 181-189, 230-250`).

**Structured stdout observation stays inside the capture bound.** Spawn/input callers
may observe stdout chunks as they arrive, but only the bytes admitted by `maxBuffer`;
the observer is best-effort and its exceptions cannot affect the child. Claude uses
this seam to decode `stream-json` without piping raw subprocess output to the terminal,
while the complete bounded stdout remains available for final-result parsing
([observed] `exec.ts` `RunOptions.onStdout` / `runWithInput`; `claude-code.ts`
`createClaudeActivityStream`).

## Retry Taxonomy

The runtime tells apart five failure classes and handles each differently. Conflating
any two reintroduces a specific bug.

**Wall-clock timeout — abandon, never retry.** A timeout on a pass means the
investigation is non-convergent; a plain retry just repeats it. So an `AgentTimeoutError`
must be treated as "abandon this task", and it propagates untouched through
`withTransientRetry`/`isTransientApiError`/`isRateLimitError` even though its message may
contain digits — it is never classified as transient or rate-limited ([observed]
`opencode.ts:677-711`, `925-960`; commit `3aeb82b`). The pass deadline is computed once
per `promptAgent` call and shared across the initial attempt and any stall retry, so no
retry can push a pass past its declared cap — `review.ts`'s overall budget math depends
on that ([observed] `opencode.ts:758-761`).

**Stall — one clean-slate retry, after an evidence check.** A silent (zero-token)
request is distinct from a slow-but-thinking one and from a genuine timeout. It gets
exactly one clean-slate retry (fresh session) if budget remains, but is first checked
against rate-limit evidence: stall plus recent explicit evidence means **wait**, not
retry, because re-sending the whole context into a limited account only makes it worse
([observed] `opencode.ts:526-587`; incident eas-cli#4084). The stall watchdog window is
always capped at half the pass's own `maxWaitMs` so it can never outlast the deadline it
protects ([observed] `opencode.ts:552-555`).

**JSON-parse failure — same-session corrective first.** Claude Code receives the local
parser's draft-07 JSON Schema and performs validation-aware retries inside the original
session before returning `structured_output`; this retains the investigation context
and names the exact missing field/type to the model. Local Zod validation still runs on
the provider-validated object. If those in-session repairs are exhausted, Claude gets
one fresh-process corrective attempt; both attempts remain in cost/token accounting.
OpenCode has no equivalent structured-output seam, so a reply that will not parse is
retried in the **same** OpenCode session first: the model still holds all the file
context it read, making the corrective a cheap cache-read
re-emit with better recall than re-investigating; only if that also fails does it fall
back to a fresh session. Claude's legacy/no-schema path retains one fresh-process
corrective as defense in depth. Parse failure and timeout are handled by entirely
separate mechanisms and must not be conflated ([observed] `schema.ts`
`structuredParser`; `claude-code.ts` `claudeCodePromptAndParse`; `opencode.ts`
`promptAndParse`).

**Finalize and corrective prompts run with every tool disabled.** The "stop and return
what you have" finalize and the "re-emit valid JSON" corrective are sent with `NO_TOOLS`
(every tool disabled, per-request), not merely instructed in prompt text. A prompt-level
plea is not enough: the finalize reply once opened seven more files and then blew its
window, losing the whole pass ([observed] `opencode.ts:120-124`).

**Transient vs rate-limit backoff.** A generic transient error (429/5xx/network blip)
retries on a fast `2s/8s` schedule (`TRANSIENT_BACKOFF_MS`); a rate-limit-classified
error gets a slower `15s/45s/90s` schedule (`RATE_LIMIT_BACKOFF_MS`), because a limited
account stays limited for tens of seconds to minutes and the fast schedule just burns
retries without waiting long enough ([observed] `opencode.ts:913-921`; commit
`188f852`).

**Subscription usage-limit — engineered to fail fast.** A subscription usage cap
(distinct from a transient throttle) resets hours later, not in seconds. Its error text
is deliberately phrased to **miss** the transient regex (`isTransientApiError`): no "rate
limit"/"429"/"too many requests"/"overloaded" substrings, and the interpolated reset
epoch is one long digit run with no internal word boundary so it cannot match `\b429\b`.
Without this it matched the 429 pattern and burned the whole rate-limit schedule on
three doomed retries. Any future edit to that message string, or to the transient
pattern list, risks re-matching it and reintroducing the bug ([observed]
`claude-code.ts:438-455` `usageLimitMessage`).

**Rate-limit evidence.** `throttle.ts` turns explicit OpenCode-log 429 lines into hard
evidence: `RateLimitWatch` scans only `level=ERROR` lines for a 429/rate-limit
signature (a chatty INFO line mentioning "retry" must not count), and fails soft — a
missing or unreadable log yields "no evidence", never an error ([observed]
`throttle.ts:33-45, 78-105`). During OAuth runs `prepareAuth` has pointed
`XDG_DATA_HOME` at the run's isolated dir, so the watched log belongs to exactly this
run's server with no cross-talk. The Claude Code engine has no such log, so it points
its `RateLimitWatch` at a deliberately nonexistent path — otherwise stale 429s from
unrelated OpenCode use on the same machine would be counted as evidence for a
Claude-engine run — and feeds evidence directly via `note()` per invocation instead
([observed] `claude-code.ts:860-864`; `throttle.ts:64-75`).
