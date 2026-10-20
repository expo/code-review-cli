// @ref LLP 0004#unified-diff-parsing [implements] — feeds 3 differently-trusted callers: 2 sources, GitHub comment anchoring
import type { DiffEntry } from "./schema.js";

/**
 * Parse a unified `git diff` into one DiffEntry per file. Splits on `diff --git`
 * headers and derives the new-tree path from the `+++ b/...` line (falling back
 * to the header) so renames and additions land on the right path.
 */
export function parseUnifiedDiff(diffText: string): DiffEntry[] {
  if (!diffText.trim()) {
    return [];
  }

  const entries: DiffEntry[] = [];
  const lines = diffText.split("\n");
  let current: string[] | null = null;

  const flush = (): void => {
    if (!current || current.length === 0) {
      return;
    }
    const entry = patchToEntry(current.join("\n"));
    if (entry) {
      entries.push(entry);
    }
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();

  return entries;
}

// @ref LLP 0004#unified-diff-parsing [implements] — binary flagged, not dropped; noise filtering is the sole exclusion point
function patchToEntry(patch: string): DiffEntry | null {
  const lines = patch.split("\n");
  const header = lines[0] ?? "";

  let newPath: string | null = null;
  let oldPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let status: string | undefined;
  let binary = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // The header ends at the first hunk. Past it, an added line `++ b/x` reads as
      // `+++ b/x`, so a PR could rename its own entry (to a lockfile noise filtering
      // drops, say) and keep the file out of review.
      break;
    }
    if (line.startsWith("+++ ")) {
      newPath = stripDiffPathPrefix(line.slice(4));
    } else if (line.startsWith("--- ")) {
      oldPath = stripDiffPathPrefix(line.slice(4));
    } else if (line.startsWith("rename from ")) {
      // Present even for a pure rename, which has no `---` line.
      renameFrom = decodeGitPath(line.slice("rename from ".length).trim());
      status = "R";
    } else if (line.startsWith("rename to ")) {
      // Unambiguous, unlike a header whose bare paths contain " b/".
      renameTo = decodeGitPath(line.slice("rename to ".length).trim());
      status = "R";
    } else if (line.startsWith("new file mode")) {
      status = "A";
    } else if (line.startsWith("deleted file mode")) {
      status = "D";
    } else if (line.startsWith("rename ")) {
      status = "R";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      // git emits one of these instead of +++/---/@@ hunks for a binary file.
      // There is no textual diff to review; flag it so noise filtering drops it.
      binary = true;
    }
  }

  let path = newPath && newPath !== "/dev/null" ? newPath : (renameTo ?? oldPath);
  if (!path || path === "/dev/null") {
    path = pathFromHeader(header);
  }
  if (!path) {
    return null;
  }
  return {
    path,
    ...(renameFrom && renameFrom !== path ? { oldPath: renameFrom } : {}),
    patch,
    status: status ?? "M",
    binary,
  };
}

function stripDiffPathPrefix(raw: string): string {
  const value = decodeGitPath(raw.trim());
  if (value === "/dev/null") {
    return value;
  }
  return value.replace(/^[ab]\//, "");
}

// One side of a `diff --git` header: a C-quoted path, or a bare one.
const QUOTED_PATH = String.raw`"(?:[^"\\]|\\.)*"`;
const HEADER = new RegExp(`^diff --git (${QUOTED_PATH}|a/.+?) (${QUOTED_PATH}|b/.+)$`);

function pathFromHeader(header: string): string | null {
  const match = header.match(HEADER);
  if (!match) {
    return null;
  }
  // Each side is quoted on its own, so a rename can mix the two forms.
  const newPath = decodeGitPath(match[2]!);
  return newPath.startsWith("b/") ? newPath.slice(2) : null;
}

const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * A path as git prints it in a diff: bare, or in double quotes with C-style escapes
 * when it has special characters. With `core.quotePath` (on by default) every
 * non-ASCII byte is an octal escape too, so `café.ts` prints as `"caf\303\251.ts"`;
 * GitHub's diffs (what `gh pr diff` returns) quote the same way. A bare path is
 * returned unchanged.
 *
 * A quoted path is also returned unchanged, still quoted, when its bytes are not
 * valid UTF-8 (distinct names would all decode to the same U+FFFD name) or when the
 * decoded name has a control, format or line-separator character. Paths reach
 * prompts, comments and logs, so a decoded newline could forge an untrusted-diff
 * boundary line, and `**` (`.*`) does not match across one.
 */
// @ref LLP 0004#unified-diff-parsing [implements] — decode git's C-quoted paths, or a non-ASCII path matches no glob and is read from a file that does not exist
export function decodeGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) {
    return token;
  }
  const bytes: Buffer[] = [];
  for (const part of token.slice(1, -1).split(/(\\[0-7]{3}|\\.)/)) {
    if (!part.startsWith("\\")) {
      bytes.push(Buffer.from(part, "utf8"));
    } else if (/^\\[0-7]{3}$/.test(part)) {
      bytes.push(Buffer.from([parseInt(part.slice(1), 8)]));
    } else {
      const escape = C_ESCAPES[part[1]!];
      bytes.push(escape === undefined ? Buffer.from(part, "utf8") : Buffer.from([escape]));
    }
  }
  let decoded: string;
  try {
    decoded = STRICT_UTF8.decode(Buffer.concat(bytes));
  } catch {
    return token;
  }
  return UNSAFE_IN_PATH.test(decoded) ? token : decoded;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Control (C0, DEL, C1), format (bidi, zero-width) and line/paragraph separators. */
const UNSAFE_IN_PATH = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
