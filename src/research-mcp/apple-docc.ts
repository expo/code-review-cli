import type { DiscoveredDocument, Language, ProviderId, SourceKind } from "./types.js";

interface DocCReference {
  url?: unknown;
  title?: unknown;
  abstract?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inlineText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const object = objectValue(item);
      return object && typeof object.text === "string" ? object.text : "";
    })
    .join("")
    .trim();
}

const readableKeys = new Set(["text", "code", "title", "name"]);
const skippedKeys = new Set([
  "anchor",
  "checksum",
  "identifier",
  "identifiers",
  "images",
  "kind",
  "role",
  "type",
  "url",
]);

function collectReadableText(value: unknown, output: string[], key?: string) {
  if (typeof value === "string") {
    if (key && readableKeys.has(key)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReadableText(item, output, key);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  for (const [childKey, child] of Object.entries(object)) {
    if (!skippedKeys.has(childKey)) collectReadableText(child, output, childKey);
  }
}

function cleanLines(lines: string[]): string {
  const output: string[] = [];
  let previous = "";
  for (const line of lines) {
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (cleaned && cleaned !== previous) {
      output.push(cleaned);
      previous = cleaned;
    }
  }
  return output.join("\n\n");
}

function languageFromIdentifier(identifier: Record<string, unknown> | null): Language | undefined {
  const language = identifier?.interfaceLanguage;
  if (language === "swift") return "swift";
  if (language === "occ" || language === "objective-c") return "objective-c";
  return undefined;
}

export interface ExtractedDocCPage {
  document: DiscoveredDocument;
  links: string[];
}

export function extractAppleDocCPage(
  json: string,
  url: string,
  source: {
    provider?: ProviderId;
    sourceKind?: SourceKind;
  } = {},
): ExtractedDocCPage | null {
  const root = objectValue(JSON.parse(json));
  const metadata = objectValue(root?.metadata);
  const identifier = objectValue(root?.identifier);
  const title = typeof metadata?.title === "string" ? metadata.title.trim() : "";
  if (!root || !metadata || !title) return null;

  const text: string[] = [];
  const abstract = inlineText(root.abstract);
  if (abstract) text.push(abstract);
  collectReadableText(root.primaryContentSections, text);
  collectReadableText(root.relationshipsSections, text);

  const links = new Set<string>();
  const references = objectValue(root.references);
  for (const value of Object.values(references ?? {})) {
    const reference = objectValue(value) as DocCReference | null;
    if (!reference || typeof reference.url !== "string") continue;
    if (reference.url.startsWith("/documentation/")) {
      links.add(reference.url);
    }
  }

  const body = cleanLines(text);
  if (body.length < 40) return null;

  const platforms = Array.isArray(metadata.platforms) ? metadata.platforms : [];
  const availability = platforms.flatMap((item) => {
    const platform = objectValue(item);
    if (!platform || typeof platform.name !== "string") return [];
    const introduced = typeof platform.introducedAt === "string" ? ` ${platform.introducedAt}` : "";
    const deprecated =
      typeof platform.deprecatedAt === "string" ? ` (deprecated ${platform.deprecatedAt})` : "";
    return [`${platform.name}${introduced}${deprecated}`];
  });
  const modules = Array.isArray(metadata.modules) ? metadata.modules : [];
  const firstModule = objectValue(modules[0]);
  const isSymbol = metadata.role === "symbol" || typeof metadata.symbolKind === "string";

  return {
    document: {
      platform: "apple",
      ...source,
      title,
      url,
      body,
      ...(typeof firstModule?.name === "string" ? { framework: firstModule.name } : {}),
      ...(isSymbol ? { symbol: title } : {}),
      ...(languageFromIdentifier(identifier)
        ? { language: languageFromIdentifier(identifier) }
        : {}),
      ...(availability.length > 0 ? { availability } : {}),
    },
    links: [...links],
  };
}
