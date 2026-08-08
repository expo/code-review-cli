export const PLATFORMS = ["apple", "android", "react-native"] as const;

export type Platform = (typeof PLATFORMS)[number];
export type PlatformFilter = Platform | "all";

export const PROVIDERS = [
  "apple",
  "apple-releases",
  "swift-evolution",
  "sdwebimage",
  "android",
  "android-releases",
  "media3",
  "glide",
  "okhttp",
  "kotlin-coroutines",
  "gradle",
  "agp",
  "jetbrains-issues",
  "expo",
  "react-native",
  "react-native-reanimated",
  "react-native-gesture-handler",
  "react-native-screens",
  "react-native-worklets",
] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export const SOURCE_KINDS = [
  "official-api",
  "official-guide",
  "release-notes",
  "issue-tracker",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const LANGUAGES = ["swift", "objective-c", "kotlin", "java"] as const;

export type Language = (typeof LANGUAGES)[number];

export interface DiscoveredDocument {
  platform: Platform;
  provider?: ProviderId;
  sourceKind?: SourceKind;
  title: string;
  url: string;
  body: string;
  framework?: string;
  symbol?: string;
  language?: Language;
  availability?: string[];
}

export interface IndexedChunk {
  id: string;
  platform: Platform;
  provider?: ProviderId;
  sourceKind?: SourceKind;
  title: string;
  url: string;
  passage: string;
  framework?: string;
  symbol?: string;
  language?: Language;
  availability?: string[];
  previousPassageId?: string;
  nextPassageId?: string;
  indexedAt: string;
}

export interface SearchResult extends IndexedChunk {
  score: number;
}

export interface SerializedSearchIndex {
  schemaVersion: 1;
  generatedAt: string;
  documentCount: number;
  chunkCount: number;
  providers: ProviderId[];
  searchIndex: unknown;
}
