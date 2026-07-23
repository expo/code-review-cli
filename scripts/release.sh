#!/usr/bin/env bash
# Bump the version and publish @expo/code-review-cli to npm.
#
#   bun run release            # patch release (default)
#   bun run release minor      # minor release
#   bun run release major      # major release
#
# Requires: a clean git tree, npm auth with publish rights to the @expo scope,
# and push access to origin.
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch | minor | major) ;;
  *)
    echo "Usage: bun run release [patch|minor|major]" >&2
    exit 1
    ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty — commit your changes before releasing." >&2
  exit 1
fi

# `npm version` bumps package.json, commits it, and creates a v<version> git tag.
# `npm publish` runs prepublishOnly (clean + build); publishConfig makes it public.
npm version "$BUMP" -m "Release v%s"
npm publish
git push --follow-tags

echo "Published @expo/code-review-cli@$(node -p "require('./package.json').version")"
