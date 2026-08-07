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
therefore supplies only an absolute `research.indexPath`, not an arbitrary command
or argument vector.

The MCP remains a process boundary rather than an in-process import. Its stdout is
the only result channel, its environment is an allowlist, it runs from the OS temp
directory, and ECR caps its runtime and output. A failure is logged and review
continues without research; it never skips or weakens an ordinary review pass.

## Index Lifecycle and Network Boundary

`review-research-mcp serve` reads the local index for every provider except Expo.
An Expo-routed query sends the already-sanitized API/concept query to
the fixed public Expo Algolia search endpoint. The browser-visible key is search-only;
redirects are rejected, response size/time/hit count are capped, every result is
schema-validated, and canonical result URLs must remain on `docs.expo.dev`. Failure
falls back to the local index. No code snippets, strings, comments, paths, credentials,
or model prompts cross that boundary.

`review-research-mcp update` is a separate, operator-invoked command for trusted
scheduled jobs. The updater uses exact HTTPS host/path allowlists, manually
revalidates redirects, checks response content types, and bounds response size,
crawl depth, page count, timeout, and delay. The Expo crawl supplies a local fallback;
precise Expo search uses the live query rather than pretending an empty-query result
page is a complete Algolia index.

An adopter without index-distribution infrastructure may run `update` in a separate
secretless workflow step from the same pinned published package and trusted base
checkout. That step must execute no PR code, receive no model credential, and fail
open so the ordinary review still runs. It is a bootstrap deployment, not a reason to
mix the crawler into the credential-bearing `ecr ci` process; mature installations
should prefer a scheduled, signed, read-only index artifact.

The generated index is deliberately not published in the npm package. Documentation
changes independently of ECR, and the current index is large enough that coupling it
to every CLI install would make releases and cache invalidation expensive. CI should
build the index outside the PR job, verify its digest, and mount it read-only at the
absolute path named by trusted base-commit config. Research-enabled reviews bypass
result-cache reuse until the index digest becomes part of the cache key.

## Query and Prompt Boundary

ECR derives queries only from added native-code identifiers. It removes comments,
string literals, deleted lines, file paths, and raw snippets; caps identifiers and
query count; and selects named providers from known code signals. The MCP tool
metadata tells direct clients to use exact symbols plus one member, behavior, or
constraint term, and to retry broad results with a narrower symbol. It explicitly
rejects prose, code, package/import names, paths, secrets, and sensitive context as
query material. MCP output is
schema-validated, limited to HTTPS URLs from the requested provider, truncated,
sanitized, and wrapped in an untrusted platform-research fence. Issue tracker text
keeps distinct provenance and is never presented as an API contract.

## Installation-Specific Research Is Deferred

The built-in source catalog covers Apple, Android, platform releases, Swift
Evolution, Media3, Glide, OkHttp, Kotlin coroutines, Gradle/AGP, selected JetBrains
issues, Expo, React Native, Reanimated, Gesture Handler, Screens, and Worklets. A
later design may let adopters select or add research capabilities through trusted
root configuration, similar to agent files. That extension must not turn arbitrary
PR-controlled URLs, commands, parsers, or executable plugins into review inputs. New
remote sources still need an operator-controlled host/path allowlist and provenance
class; scope configs remain unable to alter the research runtime or index.

Expo skills solve a different problem: pinned procedural guidance for how a reviewer
should reason or act. They may later be supplied as versioned, separately labeled
trusted context selected from root configuration. Documentation results remain
untrusted evidence with canonical sources. A crawler result must never install,
activate, or rewrite a reviewer skill.
