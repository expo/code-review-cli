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

function cleanBlock(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function referenceTitle(identifier: unknown, references: Record<string, unknown> | null): string {
  if (typeof identifier !== "string") return "";
  const reference = objectValue(references?.[identifier]);
  return typeof reference?.title === "string" ? reference.title : "";
}

function inlineContentText(value: unknown, references: Record<string, unknown> | null): string {
  if (Array.isArray(value)) {
    return value.map((item) => inlineContentText(item, references)).join("");
  }
  const object = objectValue(value);
  if (!object) return "";
  if (typeof object.text === "string") return object.text;
  if (typeof object.code === "string") return object.code;
  if (object.type === "reference") return referenceTitle(object.identifier, references);
  return Object.values(object)
    .map((child) => inlineContentText(child, references))
    .join("");
}

function collectReadableBlocks(
  value: unknown,
  references: Record<string, unknown> | null,
  output: string[],
) {
  if (Array.isArray(value)) {
    for (const item of value) collectReadableBlocks(item, references, output);
    return;
  }
  const object = objectValue(value);
  if (!object) return;

  if (Array.isArray(object.tokens)) {
    const declaration = cleanBlock(inlineContentText(object.tokens, references));
    if (declaration) output.push(declaration);
    return;
  }
  if (object.type === "paragraph") {
    const paragraph = cleanBlock(inlineContentText(object.inlineContent, references));
    if (paragraph) output.push(paragraph);
    return;
  }
  if (object.type === "heading" && typeof object.text === "string") {
    const heading = cleanBlock(object.text);
    if (heading) output.push(heading);
    return;
  }
  if (object.type === "codeListing" && Array.isArray(object.code)) {
    const code = object.code.filter((line): line is string => typeof line === "string").join("\n");
    if (code.trim()) output.push(code.trim());
    return;
  }

  if (typeof object.name === "string" && Array.isArray(object.content)) {
    const content: string[] = [];
    collectReadableBlocks(object.content, references, content);
    const body = content.join("\n\n");
    output.push(body ? `${object.name}: ${body}` : object.name);
    return;
  }
  if (object.type === "aside" && Array.isArray(object.content)) {
    const content: string[] = [];
    collectReadableBlocks(object.content, references, content);
    const label =
      typeof object.name === "string"
        ? object.name
        : typeof object.style === "string"
          ? object.style
          : "Note";
    if (content.length > 0) output.push(`${label}: ${content.join("\n\n")}`);
    return;
  }

  for (const child of Object.values(object)) {
    collectReadableBlocks(child, references, output);
  }
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
  const references = objectValue(root.references);
  collectReadableBlocks(root.primaryContentSections, references, text);
  collectReadableBlocks(root.relationshipsSections, references, text);

  const links = new Set<string>();
  for (const value of Object.values(references ?? {})) {
    const reference = objectValue(value) as DocCReference | null;
    if (!reference || typeof reference.url !== "string") continue;
    if (reference.url.startsWith("/documentation/")) {
      links.add(reference.url);
    }
  }

  const body = [...new Set(text.map(cleanBlock).filter(Boolean))].join("\n\n");
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
