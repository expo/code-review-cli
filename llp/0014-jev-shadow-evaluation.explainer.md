# LLP 0014: Jev Shadow Evaluation

**Type:** Explainer
**Status:** Active
**Systems:** Engine, Config, Security, Observability, Templates
**Author:** Expo
**Date:** 2026-09-21
**Related:** [LLP 0001](0001-trust-model.principles.md), [LLP 0002](0002-review-engine-pipeline.explainer.md), [LLP 0005](0005-verification-fingerprints-rendering.explainer.md), [LLP 0006](0006-config-schema-loading-routing.explainer.md), [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md)

Jev is a discriminative model from TypeSafe AI. It accepts a state plus typed
questions and returns probabilities for choices, boolean “Noul” questions, or an
ordered score. It does not generate explanations, remediation text, or code. ECR
therefore uses Jev as an optional shadow evaluator of the final finding set, not as
a reviewer or replacement for the coordinator and verifier.

## Evidence Survey

The primary sources are TypeSafe's [Jev announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[documentation](https://docs.typesafe.ai/), and open-source
[JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js). As of this design,
the current dated model is `jev-1.13.0`; the service also offers moving aliases.
The SDK is at `0.6.0`, supports Node 20+, reads `TYPESAFE_API_KEY`, defaults to a
10-second per-attempt timeout and two retries, and exposes each answer's probability
distribution plus token usage.

The vendor describes a 64K-token request limit, with at most 32K tokens for state,
text-only input, up to 255 Choice labels, and up to 10 Score levels. Published pricing
is $0.042 per million input tokens with no output-token charge. Published account
limits are 250,000 tokens per second and 1,200 requests per minute, subject to account
changes. These are service facts, not ECR capacity targets; ECR keeps lower local
bounds.

The vendor benchmark measures agreement with answers from frontier generative models,
not correctness against independently adjudicated human labels. Its reported speed
and cost advantages therefore justify an experiment, not authority over findings.
TypeSafe's own guidance also says that confidence measures concentration of the
returned distribution rather than correctness, thresholds require calibration on the
application's data, irrelevant context degrades results, question wording matters,
and Jev is weak at arithmetic, counting, date comparison, and complex indirection.
Customer requests are not used for training under the standard policy, while zero
data retention is an enterprise control rather than the default.

Community experiments support a narrow role. The open-source
[`jev-review`](https://github.com/devagrawal09/jev-review) workflow uses typed stages
for file profiling, evidence selection, mechanism, severity, and routing, while
explicitly treating outputs as review leads rather than proof. Other early projects
such as [`pi-warden`](https://github.com/DevMortimer/pi-warden) and
[`pi-jev`](https://github.com/y0usaf/pi-jev) emphasize paired evaluation, calibration,
and enforcement disabled by default. An independent
[hands-on review](https://jevaiguide.com/jev-review/) reports low latency on small
requests but also early documentation/API rough edges and no public research paper.
Those reports are useful implementation anecdotes, not independent validation of code
review accuracy.

## Fit With ECR

Jev fits three bounded jobs:

1. **Finding calibration:** ask whether the changed-code patch supports a final
   finding and compare its severity distribution with ECR's result.
2. **Routing:** classify a small diff or candidate finding before assigning expensive
   generative passes, once a repo-specific recall benchmark exists.
3. **Evidence triage:** rank retrieved documentation passages or verifier candidates
   before a generative model explains them.

It does not fit jobs that require synthesis: discovering an open-ended bug, tracing a
large execution path with tools, explaining causality, writing remediation, or
consolidating prose. Existing generative reviewers remain responsible for those jobs.
Deterministic code remains responsible for path confinement, schema validation,
credential boundaries, exact quote checks, protected severity floors, and all other
security invariants.

Jev must never be a prompt-injection detector or security boundary. The state is
attacker-controlled code and finding prose, and a discriminative model can be steered
by adversarial content. No Jev answer may override ECR's critical/secrets floors or
turn a failed run into approval.

## Shadow-First Integration

The root-only `jev` config is disabled by default. When enabled, ECR waits until
verification, suppression, requalification, citation handling, and feedback handling
have produced the final finding set. It then sends one request per finding, capped by
`maxFindings`, with two Choice questions:

- whether the supplied patch supports, contradicts, or is insufficient to judge the
  exact finding;
- the appropriate `suggestion`, `warning`, or `critical` severity if the finding is
  real.

The request state contains the finding's category, severity, file, line, title,
rationale, and evidence plus only that file's unified patch. `maxPatchChars` bounds
the patch; when possible, truncation centers on the cited evidence. ECR sends no PR
title/body, unrelated file, surrounding repository tree, credential, agent transcript,
or author reply. Four requests run concurrently. `maxFindings`, the SDK timeout, and
one retry bound time and provider load.

The API origin and dated model are explicit in code/config. Ambient
`TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` cannot redirect the integration or
silently move its calibration target. The SDK logger is off because debug bodies would
contain source. `TYPESAFE_API_KEY` is a dedicated workflow secret and is also in
`FORBIDDEN_TOKEN_ENVS`, so an `auth.tokenEnv` cannot forward it to a model provider.

The observation stores no additional source text. `.runs/reviews.jsonl` receives the
finding fingerprint, actual model, selected labels, full probability distributions,
token totals, duration, and coverage counts. Provider errors are counted without
persisting their text because an error may echo request details. A missing key produces
one explicit availability error. None of these values enters `CoordinatorOutput`, the
reporter, the decision calculation, or a later review prompt.

The integration is fail-open by design because it is telemetry: construction,
credential, request, timeout, and response failures leave the review byte-for-byte
unchanged. This differs from review coverage. A failed Jev observation is not a missing
review pass and must not add an `incomplete` review note.

## Calibration and Promotion Gates

“Supported” is not ground truth, and agreement with ECR can mean both systems made the
same mistake. Before Jev gains any decision effect, evaluation must join shadow records
with human outcomes such as accepted fixes, explicit dismissals, and independently
adjudicated sampled findings. Measure by category and severity, not only in aggregate:

- recall on confirmed critical, secrets, and security findings;
- precision and false-negative rate for `contradicted` and `insufficient` labels;
- calibration curves for each probability, pinned model version, and question text;
- latency, failures, retries, input tokens, and cost per reviewed PR;
- drift after any Jev model, SDK, rubric, state shape, or truncation change.

Promotion proceeds in separate changes:

1. **Shadow finding evaluator:** current phase; log only.
2. **Visible advisory:** optionally show a clearly labeled second opinion without
   changing decisions, after measured calibration.
3. **Cost routing:** let Jev skip only low-risk expensive work when a held-out benchmark
   proves the required recall; always-run security and deterministic checks remain.
4. **Finding suppression:** last and highest bar. It requires human-labeled data,
   category-specific thresholds, an audit trail, a kill switch, and hard bypasses for
   critical/secrets/security findings. No current evidence meets this bar.

Moving aliases are unsuitable for a calibrated gate. A promotion must pin a dated
model and treat every version or question change as a new classifier requiring fresh
validation. Confidence alone is never a threshold justification.

## Rejected Alternatives

**Replace the verifier.** Jev cannot inspect the repository with tools or explain the
source-level contradiction. The current verifier can re-read source and fails open;
replacing it would reduce evidence and debuggability.

**Pre-filter reviewer findings before coordination.** This creates an early silent
false-negative path exactly where ECR requires coverage honesty. Shadow evaluation of
final findings is measurable and reversible.

**Send the entire diff or repository context.** More context raises disclosure, cost,
and context-rot risk without improving the exact local judgment. One bounded file
patch is the smallest useful state.

**Use Jev for prompt-injection detection.** An attacker controls the state being
classified. Only deterministic isolation and trust boundaries can protect credentials
and execution.
