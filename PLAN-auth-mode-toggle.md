# PLAN: one-toggle api-key/oauth switch for openai, with a random A/B mode

Status: IMPLEMENTED (2026-08-01). Decisions taken:

- Same concurrency on both arms: a randomized entry pins the default to 3
  whichever mode the flip picks (`effectiveConcurrency`).
- Fail-fast on BOTH credentials, but only for `mode: "random"` entries; fixed
  modes keep the single-credential check.
- On the oauth arm, the provider's ambient key env is scrubbed for the run
  (restored on cleanup) so the API key can't silently serve oauth-labeled runs.
- The CI auth lock (`tokenEnvMismatch`) and `ecr verify-config` count
  `apiKeyEnv`/`oauthTokenEnv` alongside `tokenEnv`, so `ECR_EXPECTED_TOKEN_ENV`
  lists both names and stays stable across flips.
- `ecr setup-auth` provisions both arms for a randomized entry.
- Run log gained `authModes` (on every record) and `passOutcomes`
  (completed/failed/timedOut/stalled, split by AgentTimeoutError.reason).

Original motivation and design below. Motivation: GPT passes hit timeouts and
stalls. We want to compare reliability between token billing (API key) and the
ChatGPT/Codex subscription (oauth), per run, from field data.

## Why switching is hard today

Two fields must change together in `.expo-code-review/config.jsonc`:

1. `auth.providers.openai.mode` — `"api-key"` vs `"oauth"`.
2. `auth.providers.openai.tokenEnv` — the SAME field names a different env var
   per mode (an API key env vs the ChatGPT refresh/access token env).

`tokenEnv` is overloaded, so a single `mode` flip breaks the credential lookup.

## Proposed config shape

Extend the per-provider auth entry (`src/config/schema.ts`):

```jsonc
{
  "auth": {
    "providers": {
      "openai": {
        // "api-key" | "oauth" | "random"  ← the one toggle
        "mode": "random",
        // Mode-specific env names. Both set ⇒ any mode (incl. random) works
        // without touching anything else.
        "apiKeyEnv": "OPENAI_API_KEY",
        "oauthTokenEnv": "CODEX_OAUTH_ACCESS_TOKEN"
      }
    }
  }
}
```

Back-compat: `tokenEnv` stays valid for the fixed modes and keeps its current
meaning. `apiKeyEnv`/`oauthTokenEnv` win over `tokenEnv` when present.
`mode: "random"` REQUIRES both new fields (Zod refine).

## Resolution (per run, once)

Add a resolve step in `normalizeAuth` (config/load.ts) or at the top of
`runReview`, BEFORE `prepareAuth`, `checkProviderAuth`, and
`effectiveConcurrency`:

- `mode: "random"` → pick `"api-key"` or `"oauth"` with a 50/50 coin flip.
- Set `tokenEnv` from the matching env-name field.
- Mark the entry `randomized: true` (new optional field on `AuthConfigEntry`).

Everything downstream (isolated auth.json staging, forbidden-env deny list,
cross-provider guard, concurrency default) already keys off the resolved
`mode`/`tokenEnv`, so no other runtime change is needed.

## Guards

- `ecr doctor` and `prepareAuth` fail fast when a random entry is missing
  EITHER credential — otherwise half the runs fail at random, which poisons
  the experiment and looks like flakiness.
- The existing FORBIDDEN_TOKEN_ENVS + cross-provider-ownership checks run on
  whichever env is picked (both candidate names should be checked at doctor
  time). No new secret-forwarding surface: auth stays root-locked.
- `ecr verify-config` hashes the auth block; confirm the new fields are
  covered by its expected-env output.

## Observability (the point of the experiment)

Add to `RunLogRecord` (core/log.ts, written to `.runs/reviews.jsonl` and
uploaded as a CI artifact):

- `authModes?: Record<string, { mode: "api-key" | "oauth"; randomized: boolean }>`
- `passOutcomes?: { completed: number; failed: number; timedOut: number; stalled: number }`
  — review.ts already counts completed/failed; `AgentTimeoutError.reason`
  already distinguishes `"time"` from `"stall"`, it is just not counted today.

`rateLimitEvents`, `durationMs`, `error`, and `agentModels` are already
logged. Analysis is then one jq pass over the JSONL, grouped by
`.authModes.openai.mode`.

## Known confound

`effectiveConcurrency` defaults to 3 for oauth and 6 for api-key. That is a
real behavioral difference, not a bug — but it means mode changes two
variables at once. Pin `chunk.concurrency` (e.g. to 3) in the config while
the experiment runs to isolate the credential path.

## Alternatives considered

- Two provider entries (subscription `openai` + `openai-api` alias) — already
  supported for MIXED use, but not for A/B: model ids pin a provider at
  config time, so randomizing would mean rewriting every model id per run.
  Mode-level random keeps `openai/gpt-5.5` stable and swaps only the
  credential path.
- `ECR_OPENAI_AUTH_MODE` env override — zero-config-change lever for CI
  experiments. Can be layered on later (env wins over config `mode`).

## CI prerequisites

The workflow must export BOTH secrets (`OPENAI_API_KEY` and the Codex token)
for random mode. Note the oauth token strategy: a shared REFRESH token dies
on first rotation (single-use); use the access-token flow from
`ecr setup-auth` / a rotator job for CI.
