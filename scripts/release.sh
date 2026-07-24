#!/usr/bin/env bash
# Tag a release of @expo/code-review-cli. The tag is the single source of truth
# for the version: pushing it triggers .github/workflows/release.yml, which
# stamps the version into package.json (workspace-only), runs the checks, and
# publishes to npm via trusted publishing. Nothing version-related is committed.
#
#   bun run release 0.4.0
#
# Guardrails only — everything here can also be done with plain `git tag`.
set -euo pipefail

VERSION="${1:-}"
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "Usage: bun run release <MAJOR.MINOR.PATCH>   (e.g. bun run release 0.4.0)" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty — commit your changes before releasing." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "Releases are tagged from main (currently on $BRANCH)." >&2
  exit 1
fi

git fetch origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "main is not in sync with origin/main — pull/push first so the tag points at what's reviewed." >&2
  exit 1
fi

if npm view "@expo/code-review-cli@$VERSION" version >/dev/null 2>&1; then
  echo "@expo/code-review-cli@$VERSION already exists on npm — pick the next version." >&2
  exit 1
fi

git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin "v$VERSION"

echo "Tagged v$VERSION — CI publishes it to npm (watch the release workflow)."
