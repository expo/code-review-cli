import type { DiscoveredDocument, Platform, ProviderId, SourceKind } from "./types.js";

export interface ExtractedMarkdownPage {
  document: DiscoveredDocument;
  links: string[];
}

export function extractMarkdownDocumentationPage(
  markdown: string,
  url: string,
  platform: Platform,
  source: {
    provider?: ProviderId;
    sourceKind?: SourceKind;
  } = {},
): ExtractedMarkdownPage | null {
  const sanitized = markdown
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<script\b[^>]*>[^]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[^]*?<\/style>/gi, "")
    .replace(/\r/g, "");
  const withoutFrontMatter = sanitized.replace(/^---\n[^]*?\n---\n/, "");
  const title =
    withoutFrontMatter.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    withoutFrontMatter.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)?.[1]?.trim() ??
    "";
  const body = withoutFrontMatter
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(?:=+|-+)\s*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!title || body.length < 80) return null;

  const links = [...sanitized.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );

  return {
    document: {
      platform,
      title,
      url,
      body,
      ...source,
    },
    links,
  };
}
