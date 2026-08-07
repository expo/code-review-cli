import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
export const defaultConfigPath = fileURLToPath(
  new URL("../../research/sources.json", import.meta.url),
);
export const defaultIndexPath = fileURLToPath(
  new URL("../../research/data/docs-index.json", import.meta.url),
);
