import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONFIG_DIRNAME,
  LEGACY_CONFIG_DIRNAME,
  configDirFor,
  isConfigDirPath,
  resolveConfigDir,
} from "../config/load.js";

describe("setup dir: .expo-agents/code-review with the legacy .expo-code-review fallback", () => {
  test("a fresh repo resolves to the new name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ecr-dir-"));
    expect(configDirFor(root)).toBe(path.join(root, CONFIG_DIRNAME));
  });

  test("a pre-0.15 repo keeps using .expo-code-review unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ecr-dir-"));
    await mkdir(path.join(root, LEGACY_CONFIG_DIRNAME), { recursive: true });
    expect(configDirFor(root)).toBe(path.join(root, LEGACY_CONFIG_DIRNAME));
    expect(resolveConfigDir(root)).toBe(path.join(root, LEGACY_CONFIG_DIRNAME));
  });

  test("when both exist the new name wins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ecr-dir-"));
    await mkdir(path.join(root, LEGACY_CONFIG_DIRNAME), { recursive: true });
    await mkdir(path.join(root, CONFIG_DIRNAME), { recursive: true });
    await writeFile(path.join(root, CONFIG_DIRNAME, "config.jsonc"), "{}");
    expect(configDirFor(root)).toBe(path.join(root, CONFIG_DIRNAME));
  });

  test("an explicit override still beats both", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ecr-dir-"));
    await mkdir(path.join(root, LEGACY_CONFIG_DIRNAME), { recursive: true });
    expect(resolveConfigDir(root, "custom")).toBe(path.join(root, "custom"));
  });

  test("isConfigDirPath recognizes either spelling, nowhere else", () => {
    expect(isConfigDirPath("/r/.expo-code-review")).toBe(true);
    expect(isConfigDirPath("/r/apps/api/.expo-agents/code-review")).toBe(true);
    expect(isConfigDirPath("/r/.expo-agents")).toBe(false);
    expect(isConfigDirPath("/r/code-review")).toBe(false);
  });
});
