import { createHash } from "node:crypto";

import * as cheerio from "cheerio";

import type { DiscoveredDocument, Platform, ProviderId, SourceKind } from "./types.js";

const discardedSelectors = [
  "script",
  "style",
  "noscript",
  "svg",
  "nav",
  "footer",
  "form",
  "button",
  "[hidden]",
  "[aria-hidden='true']",
].join(",");

const blockSelectors = [
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "main",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
].join(",");

function cleanText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanTitle(value: string): string {
  return cleanText(value)
    .replace(/\s*[|–—-]\s*Apple Developer Documentation$/i, "")
    .replace(/\s*[|–—-]\s*Android Developers$/i, "")
    .trim();
}

export interface ExtractedPage {
  document: DiscoveredDocument;
  links: string[];
}

export function extractDocumentationPage(
  html: string,
  url: string,
  platform: Platform,
  source: {
    provider?: ProviderId;
    sourceKind?: SourceKind;
  } = {},
): ExtractedPage | null {
  const $ = cheerio.load(html);
  $(discardedSelectors).remove();

  const main = $("main").first().length
    ? $("main").first()
    : $("article").first().length
      ? $("article").first()
      : $("[role='main']").first().length
        ? $("[role='main']").first()
        : $("body").first();

  main.find(blockSelectors).each((_, element) => {
    $(element).append("\n");
  });

  const body = cleanText(main.text());
  const title = cleanTitle($("h1").first().text() || $("title").first().text());
  if (!title || body.length < 80) {
    return null;
  }

  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (href) {
      links.add(href);
    }
  });

  return {
    document: { platform, title, url, body, ...source },
    links: [...links],
  };
}

export function chunkDocument(
  document: DiscoveredDocument,
  indexedAt: string,
  targetCharacters = 1400,
  overlapCharacters = 180,
) {
  const paragraphs = document.body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const passages: string[] = [];
  let current = "";

  const flush = () => {
    const passage = current.trim();
    if (passage) {
      passages.push(passage);
    }
    current = passage.slice(Math.max(0, passage.length - overlapCharacters));
  };

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > targetCharacters) {
      flush();
    }

    if (paragraph.length > targetCharacters * 2) {
      let remaining = paragraph;
      while (remaining.length > targetCharacters) {
        const splitAt = remaining.lastIndexOf(" ", targetCharacters);
        const boundary = splitAt > targetCharacters / 2 ? splitAt : targetCharacters;
        current = `${current}\n\n${remaining.slice(0, boundary)}`.trim();
        flush();
        remaining = remaining.slice(boundary).trim();
      }
      current = `${current}\n\n${remaining}`.trim();
    } else {
      current = `${current}\n\n${paragraph}`.trim();
    }
  }
  flush();

  const documentId = createHash("sha256")
    .update(`${document.provider ?? document.platform}\0${document.url}\0${document.title}`)
    .digest("hex")
    .slice(0, 16);

  return passages.map((passage, chunkIndex) => ({
    ...document,
    body: undefined,
    id: `${document.provider ?? document.platform}:${documentId}#${chunkIndex}`,
    passage,
    indexedAt,
  }));
}
