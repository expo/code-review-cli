# LLP 0013: Built-in Platform Research

**Type:** Explainer
**Status:** Active
**Systems:** Research, Security, Runtime, Config, Packaging
**Author:** Expo
**Date:** 2026-08-06
**Related:** [LLP 0001](0001-trust-model.principles.md), [LLP 0002](0002-review-engine-pipeline.explainer.md), [LLP 0003](0003-model-runtimes-and-credentials.explainer.md), [LLP 0006](0006-config-schema-loading-routing.explainer.md), [LLP 0009](0009-adoption-templates-and-ci-workflows.guide.md)

`@expo/code-review-cli` ships a documentation-search MCP as a second binary in
the same npm package. ECR invokes it before model startup and passes the resulting
passages to reviewer prompts as bounded, explicitly untrusted evidence. The model
never receives the MCP as an agent tool.

## One Package, Two Binaries

The package exposes `ecr` and `review-research-mcp`. Keeping both in one package
makes the query router, MCP protocol, source adapters, tests, and review integration
one versioned unit. ECR does not resolve the MCP through `PATH`: it starts the
package-relative entry point with the current absolute Node executable. Root config
supplies only enablement, bounds, and an optional absolute fallback index path—not an
arbitrary command, endpoint, host, or argument vector.

The MCP remains a process boundary rather than an in-process import. Its stdout is
the only result channel, its environment is an allowlist, it runs from the OS temp
directory, and ECR caps its runtime and output. A failure is logged and review
continues without research; it never skips or weakens an ordinary review pass.

## Search, Fetch, and Optional Index Boundary

`review-research-mcp serve` uses Brave Web Search as discovery for non-Expo
providers. Each request combines the already-sanitized API/concept query with a fixed
provider-owned `site:` scope. The endpoint is fixed, redirects are rejected, response
size/time/hit count are capped, and only the fixed `BRAVE_SEARCH_API_KEY` credential
is forwarded into the MCP child. Search titles, snippets, and ranking are untrusted
discovery hints, never evidence.

Every discovered URL must independently pass the provider's exact HTTPS host/path
allowlist before a fetch begins. Redirects are handled manually and must remain on
the provider's request allowlist; content type, body size, redirect count, timeout,
and fetched-page count are bounded. The fetched official body—not the search
snippet—is parsed, locally ranked, truncated, and returned as evidence. Apple
documentation uses its structured DocC JSON, including symbol and availability
metadata. Search-engine sparsity produces an empty result and never broadens the
trust boundary.

Expo-routed queries use the fixed public Expo Algolia endpoint. Its browser-visible
key is search-only; redirects are rejected, response size/time/hit count are capped,
records are schema-validated, and canonical result URLs must remain on
`docs.expo.dev`.

OkHttp uses the fixed official `lysine.dev` static search index because the newly
migrated feature pages are not yet comprehensively represented in Brave. The index
has the same response-size/schema/URL constraints, is cached only within the MCP
process, and can never admit a URL outside the OkHttp provider allowlist. Brave is a
fallback when that first-party index is unavailable.

`review-research-mcp update` is a separate, operator-invoked command for trusted
scheduled jobs. The updater uses exact HTTPS host/path allowlists, manually
revalidates redirects, checks response content types, and bounds response size,
crawl depth, page count, timeout, and delay. The Expo crawl supplies a local fallback;
precise Expo search uses the live query rather than pretending an empty-query result
page is a complete Algolia index.

The crawler is not part of the ordinary review workflow. An adopter requiring an
offline fallback may run `update` in a separate scheduled secretless job from a
pinned package and trusted checkout. That job must execute no PR code, receive no
model credential, and publish a verified read-only index artifact.

The generated index is deliberately not published in the npm package. Documentation
changes independently of ECR, and coupling a snapshot to every CLI install would make
releases and invalidation expensive. If supplied, an absolute trusted-base
`research.indexPath` is fallback evidence when remote discovery fails or misses.
Research-enabled reviews bypass result-cache reuse because remote search,
documentation, and optional index content can change without a config change.

## Query and Prompt Boundary

ECR derives queries only from added native-code identifiers. It removes comments,
string literals, deleted lines, file paths, and raw snippets; caps identifiers and
query count; and selects named providers from known code signals. The MCP tool
metadata tells direct clients to use exact symbols plus one member, behavior, or
constraint term, and to retry broad results with a narrower symbol. It explicitly
rejects prose, code, package/import names, paths, secrets, and sensitive context as
query material. MCP output is
schema-validated, limited to HTTPS URLs from the requested provider, truncated,
sanitized, and wrapped in an untrusted platform-research fence. The Brave credential
is never written to MCP output, prompts, logs, or run artifacts. Issue tracker text
keeps distinct provenance and is never presented as an API contract.

## Installation-Specific Research Is Deferred

The built-in source catalog covers Apple, Android, platform releases, Swift
Evolution, Media3, Glide, OkHttp, Kotlin coroutines, Gradle/AGP, selected JetBrains
issues, Expo, React Native, Reanimated, Gesture Handler, Screens, and Worklets.
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
