import type { DiscoveredDocument, ProviderId, SourceKind } from "./types.js";

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value
        // oxlint-disable-next-line no-control-regex -- intentional untrusted-text sanitization
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function customFieldText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(customFieldText).filter(Boolean).join(", ");
  }
  const object = objectValue(value);
  return object ? cleanText(object.name) : cleanText(value);
}

export function extractYouTrackIssue(
  json: string,
  url: string,
  source: {
    provider?: ProviderId;
    sourceKind?: SourceKind;
  } = {},
): { document: DiscoveredDocument; links: string[] } | null {
  const root = objectValue(JSON.parse(json));
  const id = cleanText(root?.idReadable);
  const summary = cleanText(root?.summary);
  if (!root || !id || !summary) return null;

  const sections = [cleanText(root.description)];
  const customFields = Array.isArray(root.customFields) ? root.customFields : [];
  for (const entry of customFields) {
    const field = objectValue(entry);
    const name = cleanText(field?.name);
    const value = customFieldText(field?.value);
    if (name && value) sections.push(`${name}: ${value}`);
  }
  const comments = Array.isArray(root.comments) ? root.comments : [];
  for (const entry of comments) {
    const comment = objectValue(entry);
    const text = cleanText(comment?.text);
    if (text) sections.push(`Comment: ${text}`);
  }

  const body = sections.filter(Boolean).join("\n\n");
  if (body.length < 40) return null;
  return {
    document: {
      platform: "android",
      title: `${id}: ${summary}`,
      url,
      body,
      ...source,
    },
    links: [],
  };
}
