# LLP 0013: Built-in Platform Research

**Type:** Explainer
**Status:** Active
**Systems:** Research, Security, Runtime, Config, Packaging
**Author:** Expo
**Date:** 2026-08-06
**Related:** [LLP 0001](0001-trust-model.principles.md), [LLP 0002](0002-review-engine-pipeline.explainer.md), [LLP 0003](0003-model-runtimes-and-credentials.explainer.md), [LLP 0006](0006-config-schema-loading-routing.explainer.md), [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md)

`@expo/code-review-cli` ships a documentation-search MCP as a second binary in
the same npm package. ECR exposes that bounded MCP directly to reviewer and cross-file
passes. Those agents decide when an external contract needs evidence, search for a
precise symbol, or fetch an exact supported documentation URL already present in the
review context. Coordinator, verifier, stack-verifier, and no-tools fallback passes do
not receive the MCP.

## One Package, Two Binaries

The package exposes `ecr` and `review-research-mcp`. Keeping both in one package
makes the query router, MCP protocol, source adapters, tests, and review integration
one versioned unit. ECR does not resolve the MCP through `PATH`: it starts the
package-relative entry point with the current absolute Node executable. Root config
supplies only enablement, bounds, and an optional absolute fallback index path—not an
arbitrary command, endpoint, host, or argument vector.

The MCP remains a process boundary rather than an in-process import. Its stdout is
the only result channel, and ECR caps calls, results, and per-call duration. Each run
uses an owner-only temporary MCP configuration and append-only audit. A tool failure
remains local to research and never skips or weakens an ordinary review pass.

The environment ECR declares in that configuration is a request, not a boundary. Both
Claude Code and OpenCode merge a server's `env` onto the environment they already hold
rather than replacing it, so the declared allowlist alone leaves the engine's model
credential in the child — and under OpenCode the runner's entire ambient environment,
because the SDK spawns its server with an unfiltered `process.env`. ECR therefore does
not rely on the engines for this. The command in the configuration names a wrapper that
rebuilds the environment from an explicit allowlist and then starts the real server.
The wrapper is deliberately inert: it loads no parser and opens no socket, so the one
process that still holds the engine's credentials is not the one that parses untrusted
remote documents. Anything the engine merged in stops there.

Starting a review does not derive searches from the patch, prefetch documentation, or
start a crawl. ECR only prepares the bounded MCP configuration and audit path. Reviewer
and cross-file agents make individual search or direct-fetch calls when their reasoning
identifies an external contract that needs grounding. This keeps query selection inside
the pass that understands the candidate issue and avoids spending calls on speculative
identifier searches.

## Search, Fetch, and Optional Index Boundary

`review-research-mcp serve` uses Brave Web Search as discovery for non-Expo
providers. Each request combines the already-sanitized API/concept query with a fixed
provider-owned `site:` scope. The endpoint is fixed, redirects are rejected, response
size/time/hit count are capped, and the fixed `BRAVE_SEARCH_API_KEY` is the only
credential the wrapper admits into the server's environment. Search titles, snippets,
and ranking are untrusted discovery hints, never evidence.

One reserved call is not one request. A search selects up to four providers, each of
which issues its own discovery request and then downloads candidate pages until it has
enough results, and every page may cost up to six round trips through the redirect
chain. The call budget alone therefore understates outbound traffic by more than an
order of magnitude, so each call carries a ledger — discovery requests, page fetches,
redirect hops, total requests, elapsed time — recorded in the audit and summed for the
review. The same seam carries one end-to-end deadline per call, because no engine can
supply it: OpenCode's `mcp.timeout` bounds tool discovery rather than execution, and
Claude passes no per-call timeout at all, leaving only a per-hop limit that multiplies
instead of bounding. A call that reaches its deadline returns the evidence it already
has rather than failing.

Every discovered URL must independently pass the provider's exact HTTPS host/path
allowlist before a fetch begins. Redirects are handled manually and must remain on
the provider's request allowlist; content type, body size, redirect count, timeout,
and fetched-page count are bounded. The fetched official body—not the search
snippet—is parsed, locally ranked, truncated, and returned as evidence. Apple
documentation uses its structured DocC JSON, including symbol and availability
metadata. Search-engine sparsity produces an empty result and never broadens the
trust boundary.

Search-time page retrieval is demand-driven rather than a background prefetch. The
MCP fetches the highest-ranked allowlisted candidates in batches sized to the number
of results still needed. It advances to later candidates only when an earlier page is
rejected, unavailable, or excluded by a requested language. Candidate pages that are
not needed to fill the result limit are not downloaded.

## Direct URL Fetch Boundary

The MCP also exposes `fetch_platform_doc` for a caller that already has an exact
documentation link. It infers the narrowest matching provider from a fixed ordering,
or accepts a fixed provider id as a hint when corpora overlap. The supplied URL must
pass that provider's canonical HTTPS host/path allowlist before network access. The
request adapter, every redirect, content type, timeout, and response size then pass
the same checks as a search-discovered document. The tool fetches one page only and
returns normalized extracted text—never raw HTML or DocC JSON. An optional query
selects context within the page; it cannot turn the operation into discovery.

Direct fetch uses progressive disclosure. `focused` returns a small contiguous group
around the best passage. `section`, the default, returns at most 12,000 contiguous
characters around that match. `document` returns at most 20,000 extracted characters
and is reserved for contracts spread across a page. Every response reports the
extracted document length, returned length, truncation, anchor passage id, and a
bounded passage-id inventory. Search passages carry adjacent ids so a reviewer can
recognize missing local context and expand the canonical URL instead of broadening
discovery.

This path is useful for documentation links already present in review context. For
Apple symbol links it converts the canonical `/documentation/...` URL into Apple's
allowlisted DocC JSON request URL, preserving the human-facing canonical URL in the
result. A URL that matches no provider is rejected before `fetch`; a redirect outside
the selected provider's separate request allowlist is rejected before following it.

Expo-routed queries use the fixed public Expo Algolia endpoint. Its browser-visible
key is search-only; redirects are rejected, response size/time/hit count are capped,
records are schema-validated, and canonical result URLs must remain on
`docs.expo.dev`.

OkHttp uses the fixed official `lysine.dev` static search index because the newly
migrated feature pages are not yet comprehensively represented in Brave. The index
has the same response-size/schema/URL constraints, is cached only within the MCP
process, and can never admit a URL outside the OkHttp provider allowlist. Brave is a
fallback when that first-party index is unavailable.

There is no offline index, and no crawler to build one. Live discovery replaced the
deterministic prefetch it was designed for, and the fallback it provided was never
free: an index is an artifact whose bytes sit outside the trust boundary the rest of
the system establishes. `research.indexPath` had to be an absolute path, so it
resolved against the runner's filesystem rather than the materialized trusted base —
the trusted-base mechanism protected the config that NAMED the index, never the
contents at that path, and nothing carried a digest. Index passages were also the one
evidence source returned unbounded, while every live source is length-capped.

Removing it deletes that whole class of question rather than answering it. Every
passage a review sees is now fetched during that review from an allowlisted host,
bounded on entry. A config still naming `research.indexPath` fails to parse, so a
stale setting surfaces as an error instead of being silently ignored.

This also removes the reason researched reviews could not reuse a cached result.
Reuse was disabled whenever research was enabled because evidence depended on mounted
index contents that the cache key could not represent; with no mounted artifact, the
ordinary input hash covers the whole review again.

## Query and Prompt Boundary

Reviewer prompts and MCP tool metadata tell direct clients to use exact symbols plus
one member, behavior, or constraint term, and to retry a broad result with at most one
narrower query. The MCP then deterministically removes quoted literals, URLs, email
addresses, paths, prose stop words, overlong or high-entropy tokens, and unsupported
punctuation. Credential-shaped or secret-labeled input fails closed. The remaining
query must contain an API-like symbol — which includes hyphenated package names such
as `expo-camera` — or be a short multi-word lowercase concept phrase, stay under eight
short tokens, and fit the review-wide call budget. The concept-phrase allowance exists
because guide, release-note, and Expo topics frequently have no CamelCase symbol; its
tokens pass the same length, entropy, and secret checks, and a single generic word
still fails closed. The search tool's advertised result limit is derived from the
enforced per-call bound, and the direct-fetch focused passage count is independent of
that bound, so a caller's mental model matches what a request can return.

Provider selection preserves native platform ownership. Swift or Objective-C source
uses Apple for OS contracts; Kotlin, Java, and Gradle source uses Android for platform
contracts. Explicit library signals add the owning provider—such as SDWebImage,
Media3, Glide, or OkHttp—when library behavior also matters. Repository ownership is
not documentation ownership, so a `packages/expo-*` path does not replace Apple or
Android with Expo documentation.

These checks bound the SHAPE of an outbound request, not its information content. The
reviewing model reads repository data and then chooses the query terms and URL path,
and a token that satisfies every rule above — short, low-entropy, API-shaped — can
still encode repository-derived bytes. The provider allowlist fixes who receives a
request; it does not constrain what the request says. Research is therefore an
outbound disclosure channel to Brave and the documentation providers, appropriate only
where repository-derived terms may be shared with them, and the reviewer prompt's
instruction not to send repository text is a mitigation rather than an enforcement.

MCP output is schema-validated, limited to HTTPS URLs from the requested provider,
truncated, and sanitized. Returned passages are labeled untrusted reference data in
the reviewer prompt. The Brave credential is scoped to the MCP child and is never
written to MCP output, prompts, logs, or run artifacts. Issue tracker text keeps
distinct provenance and is never presented as an API contract.

## Research Provenance and Citations

Research is observable without exposing the Brave key or unbounded responses. Each review
prints the exact bounded queries and every accepted result's title, provider,
provenance class, and canonical URL. GitHub Actions receives that same data in its
step summary. The JSONL run log additionally stores at most the already-bounded
passage returned to the reviewer so operators can determine whether research was
useful after the fact; it still excludes PR title/body and model transcripts.

Calls refused before execution are also audited, by reason class only: a rejected
query, a rejected direct-fetch URL, or an exhausted call budget. The refused input is
never recorded — it may be exactly the material the sanitizer refused to send — but
the counts surface in progress output and the step summary so operators can see unmet
research demand and tune the budget. A budget-exhausted attempt does not consume a
reservation.

The reviewer may select a source for a finding only by copying its exact title and URL
from an MCP result. Model output crosses an engine-side grounding seam: URLs absent
from the run's append-only MCP audit are removed and accepted titles are restored from
canonical evidence. URL matching is fragment-insensitive — a model that normalizes a
copied URL by dropping its `#fragment` keeps its citation, and the audited URL (never
the model's variant) is what gets restored. Grounded sources are unioned across
duplicate reviewer findings, preserved through coordinator rewrites by the finding
fingerprint, stored in hidden comment state, and rendered as visible links. Sources do
not participate in fingerprints or severity/decision logic, and findings that did not
materially use research omit them.

A finding that cites research always reaches the adversarial verifier, and its task
inlines the audited passages behind those citations as fenced untrusted reference
data. The repository alone cannot confirm an external-behavior claim, so without the
passages the verifier would judge it from model memory — the failure mode research
exists to remove. The verifier separately reports whether the cited passages support
the claim; an explicitly unsupported citation is stripped (including its
fingerprint-carried copy) while the finding itself still stands or falls on the
ordinary verdict, and any ambiguity fails open toward keeping the citation.

A reviewer may also emit a bounded, conclusion-only `researchDecisions` record when
documentation materially confirms a finding candidate or proves one safe. These
records never enter policy or decision logic. ECR discards any record without an exact
audited source. After verification and suppression produce the final findings, ECR
counts final cited findings, supported and dismissed candidates, and unique result
URLs materially used versus unused. A narrow heuristic also counts final findings that
assert external platform behavior — a version or API-level claim, or
documented-lifecycle wording — with no grounded citation; the count is advisory
observability, never a gate. The Actions summary displays those metrics and grounded
candidate conclusions; the JSONL run record preserves the same structured data with
the queries and bounded results.

## Installation-Specific Research Is Deferred

The built-in source catalog covers Apple, Android, platform releases, Swift
Evolution, SDWebImage, Media3, Glide, OkHttp, Kotlin coroutines, Gradle/AGP, selected JetBrains
issues, Expo, React, React Native, WHATWG and W3C web specifications, Chrome DevTools
Protocol, Flow, TypeScript, the Android NDK, CMake, CocoaPods, Metro, Reanimated,
Gesture Handler, Screens, and Worklets. The React Native
additions cover the contracts its implementation must preserve: React semantics, its
web-compatible APIs, the repository's type systems, and its native build and dependency
managers. Hermes documentation is intentionally not fetched from the engine's `main`
branch because it can disagree with React Native's vendored revision. Repository PR and
issue history is intentionally not a
live evidence provider: it belongs in a versioned offline evaluation corpus used to
improve prompts, while the runtime MCP remains an API-contract channel.
The canonical OkHttp host is backed by both the
[maintainer's transfer announcement](https://jakewharton.com/the-lysine-contingency/)
and [Commonhaus's project-transfer record](https://www.commonhaus.org/activity/315.html).
A later design may let adopters select or add research capabilities through trusted
root configuration, similar to agent files. That extension must not turn arbitrary
PR-controlled URLs, commands, parsers, or executable plugins into review inputs. New
remote sources still need an operator-controlled host/path allowlist and provenance
class; scope configs remain unable to alter the research runtime or index.

Expo skills solve a different problem: pinned procedural guidance for how a reviewer
should reason or act. They may later be supplied as versioned, separately labeled
trusted context selected from root configuration. Documentation results remain
untrusted evidence with canonical sources. A crawler result must never install,
activate, or rewrite a reviewer skill.
