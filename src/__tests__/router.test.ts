import { test, expect } from "bun:test";

import { pickRoutedAgents, routeAgents } from "../core/router.js";
import type { LoadedAgent } from "../config/schema.js";
import type { OpencodeHandle } from "../core/opencode.js";

const agent = (id: string, over: Partial<LoadedAgent> = {}): LoadedAgent => ({
  id,
  description: `${id} agent`,
  alwaysRun: false,
  model: "anthropic/claude-sonnet-5",
  temperature: 0.1,
  tools: { read: true },
  promptText: id,
  ...over,
});

const correctness = agent("correctness");
const security = agent("security", { alwaysRun: true });
const ios = agent("ios", { paths: ["packages/ios/**"] });

test("pickRoutedAgents: unions alwaysRun candidates and keeps candidate order", () => {
  expect(pickRoutedAgents([correctness, ios, security], ["ios"])).toEqual({
    agents: [ios, security],
    routed: true,
  });
});

test("pickRoutedAgents: ignores ids outside the candidates (agents the paths filter left out)", () => {
  // `security` is alwaysRun but its paths matched nothing, so it is not a candidate.
  const result = pickRoutedAgents([correctness], ["security", "ios", "correctness"]);
  expect(result).toEqual({ agents: [correctness], routed: true });
});

test("pickRoutedAgents: an empty pick falls back to the candidates, not the full roster", () => {
  expect(pickRoutedAgents([correctness, ios], ["unknown"])).toEqual({
    agents: [correctness, ios],
    routed: false,
  });
});

test("routeAgents: a router failure falls back to the candidates it was given", async () => {
  // Any model call on this handle throws, which exercises the fallback path.
  const handle = {} as OpencodeHandle;
  const result = await routeAgents(handle, [correctness, ios], []);
  expect(result).toEqual({ agents: [correctness, ios], routed: false });
});
