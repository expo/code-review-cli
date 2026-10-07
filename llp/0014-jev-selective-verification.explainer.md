# LLP 0014: Jev Selective Verification

**Type:** Explainer
**Status:** Active
**Systems:** Engine, Config, Security, Observability, Templates
**Author:** Expo
**Date:** 2026-09-21
**Related:** [LLP 0001](0001-trust-model.principles.md), [LLP 0002](0002-review-engine-pipeline.explainer.md), [LLP 0005](0005-verification-fingerprints-rendering.explainer.md), [LLP 0006](0006-config-schema-loading-routing.explainer.md), [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md)

Jev is a discriminative model from TypeSafe AI. It answers typed questions over
provided state and returns a probability distribution; it does not browse a repo,
discover open-ended defects, explain causality, or write remediation. ECR therefore
uses Jev inside verification, after generative reviewers have produced findings.

## Decision

ECR uses an active `generate → classify → defer` cascade. Jev is neither a shadow
observer nor another general reviewer agent:

1. generative reviewers discover and explain candidate defects;
2. deterministic code confines paths and grades quoted evidence;
3. Jev makes one atomic local support judgment per finding;
4. high-confidence support keeps the finding, while high-confidence contradiction
   drops only ordinary correctness/quality findings;
5. uncertainty and protected findings defer to the existing reasoning verifier.

Adding the root `jev` config activates the cascade. There is no separate `enabled`
flag and no shadow phase. If the config, credential, or a usable response is absent,
the finding follows the pre-Jev verification rules.

## Evidence Survey

The primary implementation sources are TypeSafe's [Jev announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[System One guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one),
[confidence guidance](https://docs.typesafe.ai/confidence),
[confidence-routing pattern](https://docs.typesafe.ai/patterns/confidence-routing),
[citation-check cookbook](https://docs.typesafe.ai/cookbooks/citation_check),
[software-development cascade](https://docs.typesafe.ai/cookbooks/sde_cascade),
[Jev 1.13 model notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13), and the
open-source [JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js).

The consistent vendor guidance is to keep deterministic control flow in code, ask
narrow independent questions over relevant state, act only above a risk-appropriate
confidence threshold, and route uncertain results to a stronger reasoner. Confidence
measures concentration of the answer distribution, not factual correctness. Jev is
also documented as weak on arithmetic, counting, dates, complex indirection, and
irrelevant context. These limits rule out using it as the only verifier.

The architecture also follows older work on selective prediction and abstention:
[SelectiveNet](https://proceedings.mlr.press/v97/geifman19a),
[Learning to Defer](https://proceedings.mlr.press/v119/mozannar20b.html),
[Calibrated Learning to Defer](https://proceedings.mlr.press/v162/verma22c.html), and
[Language Model Cascades](https://arxiv.org/abs/2207.10342). Their shared idea is
that a useful classifier should act on its competence region and reject or defer the
rest. [Generative Verifiers](https://openreview.net/forum?id=Ccwp4tFEtE) further
supports retaining a generative verifier for multi-step reasoning rather than treating
a discriminative score as universal proof.

Code-review-specific evidence argues for conservative authority. Research on
[LLM code-review overcorrection](https://arxiv.org/abs/2603.00539),
[security code review](https://arxiv.org/abs/2401.16310), and
[judge calibration and bias](https://aclanthology.org/2025.acl-long.808/) shows that
binary judgments can be confidently wrong and that security claims need stronger
grounding. Vendor benchmarks measure agreement with other model outputs rather than
human-adjudicated ECR findings, so they establish speed and structured behavior, not
an acceptable false-negative rate for this repository.

The useful philosophical analogy is dual-process reasoning: Jev supplies a fast,
bounded System 1 judgment; the tool-using verifier supplies slower System 2 analysis.
The relevant engineering principle is a reject option, not majority voting. Jev's
different model family adds diversity, but agreement between two models is not ground
truth and disagreement is a reason to inspect, not to average blindly.

## Active Selective Cascade

The policy is intentionally asymmetric:

| Jev result | Ordinary correctness/quality | Critical, security, secrets, or cited |
| --- | --- | --- |
| supported at or above threshold | keep | cited findings defer; other protected findings keep |
| contradicted at or above threshold | drop with an audit reason | defer to reasoning verifier |
| `needs_reasoning` or low confidence | defer to reasoning verifier | defer to reasoning verifier |
| missing response or provider failure | use original verification path | use original verification path |

“Protected” controls the dangerous direction: Jev may help retain such a finding, but
cannot suppress it alone. Cited findings always defer because Jev receives repository
source, not the audited external passage whose support must be checked.

The default `minConfidence` is `0.9`. It is a conservative operating point, not a
claim of 90% correctness. Repositories may change it explicitly, but model version,
question text, state shape, threshold, and truncation policy form one classifier and
must be reviewed together. A dated model is preferred over a moving alias.

## State and Security Boundaries

Each request includes finding category, severity, file, line, title, rationale, and
quoted evidence plus bounded source from that file. ECR sends no PR title/body,
unrelated file, agent transcript, author reply, or credential. `maxContextChars`
bounds disclosure and context rot; truncation centers on the quoted evidence where
possible. Four requests run concurrently, with a bounded timeout and one retry.

The API origin is explicit. Ambient TypeSafe URL/model variables cannot redirect the
request. SDK logging is off because bodies contain source. `TYPESAFE_API_KEY` is
captured before reviewer startup, withheld from OpenCode, and forbidden as a reviewer
provider credential. Paths remain confined to the materialized review tree before
any source is read.

Jev is not a prompt-injection detector or security boundary. The code and finding
text are attacker-controlled inputs, and model output is schema-validated before the
policy sees it. Deterministic code continues to own credential isolation, path
confinement, evidence matching, category floors, and final decision derivation.

## Failure and Observability

The cascade fails back, not closed. Missing credentials disable only Jev for that run.
An individual timeout, malformed response, or provider error sends that finding
through the original verification path. Error text is not persisted because providers
may echo source. The run log stores aggregate model, duration, token, cost, evaluated,
and failure counts; any finding dropped by Jev appears in the ordinary
`verifierDropped` audit trail with its confidence.

Published pricing for the pinned integration is $0.042 per million input tokens with
no output-token charge. Cost is recorded in the `jev-verifier` bucket. Provider limits
are not treated as local capacity guarantees.

## What Jev Replaces

Jev replaces only straightforward finding verification calls. It does not replace:

- reviewer agents that discover bugs and supply explanations;
- the coordinator that merges and prioritizes findings;
- deterministic evidence, trust, and security checks;
- the reasoning verifier for ambiguity, multi-file behavior, runtime semantics,
  citations, or protected negative judgments.

This division gives Jev real authority and cost benefit without pretending that a
fast typed classifier is a complete code reviewer.

## Rejected Alternatives

**A standalone `jev.md` reviewer agent.** Jev cannot use ECR's browsing tools or emit
the finding schema's explanation and remediation. Presenting it as a peer reviewer
would hide a different and narrower capability behind the same abstraction.

**Shadow-only operation.** It adds latency and cost without improving the review. The
safe boundary comes from abstention, protected categories, and fallback behavior, not
from making every result inert.

**Replace all verification.** Local classification cannot resolve missing repository
context, multi-step execution, arithmetic, temporal behavior, or external citations.

**Use confidence as proof.** A concentrated distribution can still be wrong. The
threshold is a routing policy and protected contradictions still require reasoning.

**Send the entire diff or repository.** Unrelated context increases disclosure and
context rot. One bounded file is the smallest state that supports the local question.
