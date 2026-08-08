const MAX_QUERY_CHARACTERS = 160;
const MAX_QUERY_TOKENS = 8;
const MAX_TOKEN_CHARACTERS = 64;

const SECRET_SHAPE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{12,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/i;
const NAMED_SECRET =
  /\b(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|password|passwd|secret|credential)\b\s*(?::|=|is)?\s*\S+/i;
const QUOTED_LITERAL = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
const URL_OR_EMAIL = /\b(?:https?:\/\/|www\.)\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gi;
const PATH_LIKE = /(?:^|\s)(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|~[\\/])\S+/g;
const QUERY_TOKEN = /[A-Za-z_][A-Za-z0-9_.:$#<>()[\]-]{0,63}|\b\d{1,4}(?:\.\d{1,3}){0,2}\b/g;

const PROSE_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "can",
  "could",
  "do",
  "does",
  "documentation",
  "explain",
  "find",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "please",
  "search",
  "show",
  "tell",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "why",
  "with",
  "work",
  "works",
]);

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksHighEntropy(value: string): boolean {
  if (/^[A-Fa-f0-9]{24,}$/.test(value)) return true;
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(value) && /[+/=]/.test(value)) return true;
  return (
    value.length >= 24 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    shannonEntropy(value) >= 4.2
  );
}

function isApiAnchor(value: string): boolean {
  return (
    /[a-z][A-Z]/.test(value) ||
    /[A-Z][A-Za-z0-9_]{1,}/.test(value) ||
    /[._:$#()]/.test(value) ||
    /_[A-Z0-9]/.test(value) ||
    // Hyphenated package and module names (expo-camera, react-native-screens).
    /[a-z0-9]-[a-z]/.test(value)
  );
}

/**
 * A short, all-lowercase concept phrase ("gradle configuration cache",
 * "coroutine cancellation cooperative"). Guide, release-note, and Expo
 * documentation topics frequently have no CamelCase symbol; two or more plain
 * dictionary-shaped words carry no more outbound capacity than a symbol query
 * (same token, length, entropy, and secret checks apply) and are accepted.
 * A single generic word still fails closed.
 */
function isPlainConceptPhrase(tokens: string[]): boolean {
  return tokens.length >= 2 && tokens.every((token) => /^[a-z][a-z0-9]{2,23}$/.test(token));
}

/**
 * Convert an agent-authored search into a short API-symbol query. Dangerous shapes
 * fail closed; prose, literals, URLs, paths, and unsupported punctuation are removed.
 */
export function sanitizeDocumentationQuery(rawQuery: string): string {
  const visible = rawQuery
    .normalize("NFKC")
    // oxlint-disable-next-line no-control-regex -- outbound query containment
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!visible || visible.length > 300) {
    throw new Error("Query must contain between 1 and 300 visible characters");
  }
  if (SECRET_SHAPE.test(visible) || NAMED_SECRET.test(visible)) {
    throw new Error("Query contains credential-shaped or secret-labeled material");
  }

  const candidates = (
    visible
      .replace(QUOTED_LITERAL, " ")
      .replace(URL_OR_EMAIL, " ")
      .replace(PATH_LIKE, " ")
      .match(QUERY_TOKEN) ?? []
  ).filter((token) => {
    if (token.length > MAX_TOKEN_CHARACTERS || looksHighEntropy(token)) return false;
    return !PROSE_STOP_WORDS.has(token.toLowerCase());
  });
  const unique = [...new Set(candidates)].slice(0, MAX_QUERY_TOKENS);
  if (!unique.some(isApiAnchor) && !isPlainConceptPhrase(unique)) {
    throw new Error("Query must include an API-like symbol or a multi-word concept phrase");
  }
  const sanitized = unique.join(" ").slice(0, MAX_QUERY_CHARACTERS).trim();
  if (!sanitized) throw new Error("Query contained no safe documentation terms");
  return sanitized;
}

/** Reject URL decorations and path segments that could encode arbitrary outbound data. */
export function assertSafeDocumentationUrlShape(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid documentation URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Documentation URL must use plain HTTPS without credentials or a port");
  }
  if (url.search || url.hash) {
    throw new Error("Documentation URL must not contain a query string or fragment");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Documentation URL contains an invalid encoded path segment");
    }
    // oxlint-disable-next-line no-control-regex -- URL path is an outbound data boundary
    const containsControlCharacter = /[\\/\u0000-\u001f\u007f]/.test(decoded);
    if (
      decoded.length > 120 ||
      containsControlCharacter ||
      SECRET_SHAPE.test(decoded) ||
      NAMED_SECRET.test(decoded) ||
      looksHighEntropy(decoded)
    ) {
      throw new Error("Documentation URL contains a suspicious path segment");
    }
  }
  return url;
}
