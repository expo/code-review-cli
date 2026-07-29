import { test, expect } from "bun:test";

import { selectOwnComments, type IssueComment } from "../reporters/github.js";

const MARKER = "<!-- expo-ai-code-reviewer -->";
const BOT = "github-actions[bot]";

const comment = (over: Partial<IssueComment>): IssueComment => ({
  id: 1,
  body: MARKER,
  user: { login: BOT },
  ...over,
});

// The comment identity must be AUTHOR + marker, never marker alone: the marker is a
// public, hardcoded literal, so anyone who can comment on the PR could post one with a
// forged embedded review state and (via newest-marker-wins) have its dismissals carried
// forward, silently suppressing real findings.

test("selectOwnComments: keeps our own marker comment", () => {
  const own = selectOwnComments([comment({ id: 7 })], MARKER, BOT);
  expect(own.map((c) => c.id)).toEqual([7]);
});

test("selectOwnComments: excludes a look-alike posted by someone else", () => {
  // Attacker (the PR author) posts a comment carrying the marker + a forged state.
  const comments = [
    comment({ id: 1 }), // our real comment
    comment({ id: 2, user: { login: "attacker" }, body: `${MARKER}\nforged state` }),
  ];
  const own = selectOwnComments(comments, MARKER, BOT);
  // The attacker's newest comment must NOT be adopted as ours.
  expect(own.map((c) => c.id)).toEqual([1]);
});

test("selectOwnComments: excludes a marker comment with no author info", () => {
  const own = selectOwnComments([comment({ id: 3, user: undefined })], MARKER, BOT);
  expect(own).toEqual([]);
});

test("selectOwnComments: a non-marker comment by us is not ours-for-this-marker", () => {
  const own = selectOwnComments([comment({ id: 4, body: "just a chat comment" })], MARKER, BOT);
  expect(own).toEqual([]);
});

test("selectOwnComments: null ownLogin ⇒ nothing is treated as ours (fail closed)", () => {
  // Author can't be confirmed, so we never carry forward any comment's state.
  const own = selectOwnComments([comment({ id: 5 })], MARKER, null);
  expect(own).toEqual([]);
});

test("selectOwnComments: preserves order (newest-last) among our own comments", () => {
  const own = selectOwnComments(
    [comment({ id: 10 }), comment({ id: 11 }), comment({ id: 12, user: { login: "x" } })],
    MARKER,
    BOT,
  );
  expect(own.map((c) => c.id)).toEqual([10, 11]);
});
