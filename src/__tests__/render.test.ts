import { test, expect } from "bun:test";

import {
  renderMarkdown,
  parseEmbeddedFingerprints,
  parseReviewState,
  buildDiffLineIndex,
  renderInlineCommentBody,
} from "../core/render.js";
import { fingerprintFinding } from "../core/schema.js";
import type { CoordinatorOutput, Finding } from "../core/schema.js";

const base: CoordinatorOutput = {
  decision: "approve",
  findings: [],
  summary: "ok",
  incomplete: [],
};
const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "T",
  rationale: "r",
  ...over,
});

test("parseEmbeddedFingerprints round-trips even with a regex-metachar comment tag", () => {
  const tag = "expo.ai+review(x)"; // contains . + ( ) — must be escaped in the parser
  const body = renderMarkdown({ ...base, findings: [finding()] }, tag);
  expect(parseEmbeddedFingerprints(body, tag).length).toBe(1);
});

test("setup note renders only when there is ref advice, and never as a finding", () => {
  expect(renderMarkdown(base, "tag")).not.toContain("Review setup");
  const body = renderMarkdown(
    { ...base, setupNotes: ["The reviewer setup cites code that no longer resolves (1 ref(s))."] },
    "tag",
  );
  expect(body).toContain("🔗 **Review setup:**");
  expect(body).toContain("no longer resolves");
  // advice does not change the decision or the findings list
  expect(body).toContain("No findings.");
});

test("coverage note only renders when incomplete is non-empty (no more wolf-crying)", () => {
  expect(renderMarkdown(base, "tag")).not.toContain("Coverage note");
  expect(renderMarkdown({ ...base, incomplete: ["a pass timed out"] }, "tag")).toContain(
    "Coverage note",
  );
});

test("a dismissed finding moves to the collapsed section, not the main list", () => {
  const f = finding({ title: "W", evidence: "const somethingLongEnough = 1;" });
  const fp = fingerprintFinding(f);
  const out = renderMarkdown({ ...base, findings: [f] }, "tag", [
    { fp, by: "x", reason: "intentional" },
  ]);
  expect(out).toContain("Dismissed on this PR (1)");
  expect(out).toContain(`id:${fp}`);
  expect(out).not.toMatch(/###.*Warning/); // not shown as an active warning
});

test("review state (review + dismissals) round-trips via parseReviewState", () => {
  const dismissed = [{ fp: "abc123def456", by: "x" }];
  const body = renderMarkdown({ ...base, findings: [finding()] }, "tag", dismissed);
  const state = parseReviewState(body, "tag");
  expect(state).not.toBeNull();
  expect(state!.dismissed).toEqual(dismissed);
  expect(state!.review.findings.length).toBe(1);
});

test("grounded documentation sources render visibly and survive hidden state", () => {
  const cited = finding({
    sources: [
      {
        title: "menuStyle(_:)",
        url: "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
      },
    ],
  });
  const body = renderMarkdown({ ...base, findings: [cited] }, "tag");
  expect(body).toContain(
    "**Sources:** [menuStyle(_:)](<https://developer.apple.com/documentation/swiftui/view/menustyle(_:)>)",
  );
  expect(parseReviewState(body, "tag")?.review.findings[0]?.sources).toEqual(cited.sources);
});

test("review input hash round-trips only in hidden comment state", () => {
  const inputHash = "a".repeat(64);
  const body = renderMarkdown(base, "tag", [], undefined, [], [], inputHash);
  expect(parseReviewState(body, "tag")!.inputHash).toBe(inputHash);
  expect(Buffer.from(inputHash).toString("base64")).not.toBe(inputHash);
  expect(body).not.toContain(inputHash);
});

test("review trace stays hidden and survives state-driven re-rendering", () => {
  const review: CoordinatorOutput = {
    ...base,
    reviewTrace: {
      version: 1,
      trust: "unverified-model-diagnostics",
      agents: {
        correctness: {
          checked: ["Traced the changed option through both public entry points."],
          uncertainties: ["No deterministic test drives the platform callback."],
        },
      },
    },
  };
  const body = renderMarkdown(review, "tag");
  expect(body).not.toContain("Traced the changed option");
  const state = parseReviewState(body, "tag")!;
  expect(state.review.reviewTrace).toEqual(review.reviewTrace);

  const rerendered = renderMarkdown(state.review, "tag", state.dismissed);
  expect(parseReviewState(rerendered, "tag")!.review.reviewTrace).toEqual(review.reviewTrace);
});

test("agent summaries render collapsed under the summary, one plain line per agent", () => {
  const review: CoordinatorOutput = {
    ...base,
    summary: "Overall summary.",
    agentSummaries: [
      { agent: "docs", summary: "Checked the guide. Ping @someone <br> and <!-- tag:state=x -->." },
      { agent: "correctness" },
      { agent: "native-abi", notRun: "paths" },
      { agent: "security", notRun: "router" },
    ],
  };
  const body = renderMarkdown(review, "tag");
  const section = body.indexOf("<details>\n<summary>🔎 Reviewer summaries (4)</summary>");
  expect(section).toBeGreaterThan(body.indexOf("Overall summary."));
  expect(body).toContain(
    "- **docs:** Checked the guide. Ping @\u200Bsomeone and &lt;!-- tag:state=x -->.",
  );
  expect(body).toContain("- **correctness:** _no summary_");
  expect(body).toContain("- **native-abi:** _not run: no changed file matches its `paths`_");
  expect(body).toContain("- **security:** _not run: the router did not select it_");

  const state = parseReviewState(body, "tag")!;
  expect(state.review.agentSummaries).toEqual(review.agentSummaries);
  expect(renderMarkdown(state.review, "tag", state.dismissed)).toContain(
    "🔎 Reviewer summaries (4)",
  );
  expect(renderMarkdown(base, "tag")).not.toContain("Reviewer summaries");
});

test("a backtick before `@` does not keep a mention live in an agent summary", () => {
  // A closing backtick ends the code span, and a lone backtick starts none.
  const body = renderMarkdown(
    {
      ...base,
      agentSummaries: [{ agent: "docs", summary: "Closed `x`@octocat, open `@expo/team." }],
    },
    "tag",
  );
  expect(body).toContain("Closed `x`@\u200Boctocat, open `@\u200Bexpo/team.");
});

test("a mention renders visibly under the summary and names only valid logins", () => {
  const review: CoordinatorOutput = {
    ...base,
    summary: "Overall summary.",
    mentions: [
      {
        agent: "docs",
        logins: ["amandeepmittal", "expo/docs", "not a login"],
        reason: "Ask @someone else <br> to look.",
      },
    ],
  };
  const body = renderMarkdown(review, "tag");
  const line =
    "> 📣 @amandeepmittal @expo/docs: the `docs` reviewer asks for your review. Ask @\u200Bsomeone else to look.";
  expect(body).toContain(line);
  expect(body.indexOf(line)).toBeGreaterThan(body.indexOf("Overall summary."));
  expect(body).not.toContain("not a login");

  const state = parseReviewState(body, "tag")!;
  expect(state.review.mentions).toEqual(review.mentions);
  expect(renderMarkdown(state.review, "tag", state.dismissed)).toContain(line);
  expect(renderMarkdown(base, "tag")).not.toContain("📣");
});

/** The `@login` / `@org/team` mentions GitHub would notify in `body`, before its state. */
const liveMentions = (body: string): string[] =>
  [...body.split("<!-- tag:")[0]!.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9][\w/-]*)/g)].map(
    (match) => match[1]!,
  );

test("model text in the comment and inline bodies never notifies; only the configured mention does", () => {
  const mentioning = finding({
    title: "Ask @title-user",
    rationale: "Line one.\n@rationale-user should look at `@expo/team`.",
    suggestion: "Ping @suggest-user.",
    sources: [{ title: "Notes by @source-user", url: "https://example.com/a" }],
  });
  const requalified = finding({
    title: "Moved @moved-user",
    evidence: "const requalifiedThing = 1;",
    requalifiedBy: { prNumber: 7, file: "b.ts", reason: "Fixed by @reason-user" },
  });
  const review: CoordinatorOutput = {
    ...base,
    summary: "Coordinator thanks @summary-user.",
    findings: [mentioning, requalified],
    mentions: [{ agent: "docs", logins: ["amandeepmittal"], reason: "New guide." }],
  };
  const body = renderMarkdown(review, "tag");
  expect(liveMentions(body)).toEqual(["amandeepmittal"]);
  // Still readable: the zero-width space is the only change, and lines survive.
  expect(body).toContain("Coordinator thanks @\u200Bsummary-user.");
  expect(body).toContain("  @\u200Brationale-user should look at `@\u200Bexpo/team`.");
  expect(liveMentions(renderInlineCommentBody(mentioning, "tag", "abc"))).toEqual([]);
});

test("a handle notifies once per comment: it stays live while present, and returns without a mention", () => {
  const asking: CoordinatorOutput = {
    ...base,
    mentions: [{ agent: "docs", logins: ["Octocat", "expo/docs"], reason: "New guide." }],
  };
  const live = "> 📣 @Octocat @expo/docs: the `docs` reviewer asks for your review.";
  const quiet = "> 📣 @\u200BOctocat @\u200Bexpo/docs: the `docs` reviewer asks for your review.";
  const next = (body: string, review: CoordinatorOutput): string => {
    const state = parseReviewState(body, "tag")!;
    return renderMarkdown(review, "tag", [], undefined, [], [], undefined, state.mentioned);
  };
  const first = renderMarkdown(asking, "tag");
  expect(first).toContain(live);
  // A re-review that still asks keeps the same live mentions, so the edit adds none.
  const steady = next(first, asking);
  expect(steady).toContain(live);
  const dropped = next(steady, base);
  expect(dropped).not.toContain("📣");
  // The request comes back: an edit that re-adds a live mention would notify again.
  const back = next(dropped, asking);
  expect(back).toContain(quiet);
  expect(liveMentions(back)).toEqual([]);
  expect(next(back, asking)).toContain(quiet);
  // A handle the comment never notified still notifies.
  const other = next(back, {
    ...base,
    mentions: [{ agent: "docs", logins: ["octocat", "hubot"], reason: "Again." }],
  });
  expect(liveMentions(other)).toEqual(["hubot"]);
});

test("links a finding location to the PR diff line when the line is in the diff", () => {
  const out = renderMarkdown(
    { ...base, findings: [finding({ file: "src/a.ts", line: 12 })] },
    "tag",
    [],
    {
      repo: "expo/eas-cli",
      prNumber: 42,
      diffLines: new Map([["src/a.ts", new Set([12])]]),
    },
  );
  // Markdown link wrapping the `file:line`, pointing at the Files-changed diff anchor.
  expect(out).toContain("[`src/a.ts:12`](https://github.com/expo/eas-cli/pull/42/files#diff-");
  expect(out).toMatch(/R12\)/); // right-hand line anchor for line 12
});

test("a finding NOT in the diff links to the source blob on the base (not a dead diff anchor)", () => {
  // Line 99 is not a changed line → link to the base blob, not the diff anchor.
  const out = renderMarkdown(
    { ...base, findings: [finding({ file: "src/a.ts", line: 99 })] },
    "tag",
    [],
    {
      repo: "expo/eas-cli",
      prNumber: 42,
      diffLines: new Map([["src/a.ts", new Set([12])]]),
      baseSha: "abc123",
    },
  );
  expect(out).toContain(
    "[`src/a.ts:99`](https://github.com/expo/eas-cli/blob/abc123/src/a.ts#L99)",
  );
  expect(out).not.toContain("/pull/42/files#diff-"); // not the diff anchor
});

test("a finding on a file absent from the diff links to the base blob", () => {
  const out = renderMarkdown(
    { ...base, findings: [finding({ file: "other.ts", line: 3 })] },
    "tag",
    [],
    {
      repo: "expo/eas-cli",
      prNumber: 42,
      diffLines: new Map([["src/a.ts", new Set([12])]]),
      baseSha: "abc123",
    },
  );
  expect(out).toContain("[`other.ts:3`](https://github.com/expo/eas-cli/blob/abc123/other.ts#L3)");
});

test("out-of-diff finding is plain text when no base SHA is available", () => {
  const out = renderMarkdown(
    { ...base, findings: [finding({ file: "other.ts", line: 3 })] },
    "tag",
    [],
    {
      repo: "expo/eas-cli",
      prNumber: 42,
      diffLines: new Map([["src/a.ts", new Set([12])]]),
    },
  );
  expect(out).toContain("`other.ts:3`");
  expect(out).not.toContain("https://github.com");
});

test("location is plain (unlinked) code when no link context is given", () => {
  const out = renderMarkdown(
    { ...base, findings: [finding({ file: "src/a.ts", line: 12 })] },
    "tag",
  );
  expect(out).toContain("`src/a.ts:12`");
  expect(out).not.toContain("https://github.com");
});

test("buildDiffLineIndex: collects right-side added + context lines, skips deletions", () => {
  const patch = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " context10", // right line 10 (context)
    "-removed", // left only, no right line
    "+added11", // right line 11
    "+added12", // right line 12
    " context13", // right line 13
  ].join("\n");
  const index = buildDiffLineIndex([{ path: "src/a.ts", patch }]);
  expect([...index.get("src/a.ts")!].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
});

test('comment footer no longer says "Phase 1"', () => {
  expect(renderMarkdown(base, "tag")).not.toContain("Phase 1");
});

test("renders per-severity headers with counts", () => {
  const out = renderMarkdown(
    {
      ...base,
      decision: "request_changes",
      findings: [
        finding({ severity: "critical", category: "security", title: "C" }),
        finding({ severity: "warning", title: "W" }),
      ],
    },
    "tag",
  );
  expect(out).toMatch(/Critical \(1\)/i);
  expect(out).toMatch(/Warning \(1\)/i);
});

test("a rationale ending in </details> does not swallow the next finding's bullet", () => {
  // Regression: findings were pushed back-to-back and only the rationale's FIRST
  // line was indented, so the embedded <details> escaped the list item. GitHub
  // then treated everything up to the next blank line as raw text, and every
  // finding after the first in a group rendered with visible ** and backticks.
  const withDetails = (title: string) =>
    finding({
      severity: "critical",
      title,
      rationale:
        "**Confidence:** High — traced.\n\n<details>\n<summary>Evidence and reasoning</summary>\n\nThe path.\n\n</details>",
    });
  const body = renderMarkdown(
    {
      ...base,
      decision: "request_changes",
      findings: [withDetails("First"), withDetails("Second")],
    },
    "tag",
  );

  const lines = body.split("\n");
  let closingDetailsCount = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== "</details>") continue;
    closingDetailsCount++;
    // The line after a closing </details> must be blank, or Markdown after it is
    // emitted raw.
    expect(lines[index + 1] ?? "").toBe("");
  }
  expect(closingDetailsCount).toBe(2);

  // Both bullets must survive as list items rather than one leaking into the other.
  expect(lines.filter((line) => line.startsWith("- **")).length).toBe(2);
  expect(body).toContain("- **Second**");
});

test("a suggestion after </details> resumes Markdown after a blank line", () => {
  const body = renderMarkdown(
    {
      ...base,
      findings: [
        finding({
          rationale:
            "**Confidence:** High.\n\n<details>\n<summary>Evidence and reasoning</summary>\n\nThe path.\n\n</details>",
          suggestion: "Keep the formatting intact.",
        }),
      ],
    },
    "tag",
  );

  const lines = body.split("\n");
  const closingDetails = lines.findIndex((line) => line.trim() === "</details>");
  expect(closingDetails).toBeGreaterThan(-1);
  expect(lines[closingDetails + 1]).toBe("");
  expect(lines[closingDetails + 2]).toBe("  **Suggestion:** Keep the formatting intact.");
  expect(body).not.toContain("_Suggestion:_");
});

test("multi-line rationales stay indented inside their list item", () => {
  const body = renderMarkdown(
    { ...base, findings: [finding({ rationale: "line one\n\n<details>\nx\n</details>" })] },
    "tag",
  );
  // Non-blank continuation lines are indented to the content column; blank lines
  // stay exactly empty so they still terminate HTML blocks.
  expect(body).toContain("  <details>");
  expect(body).not.toMatch(/^ +$/m);
});
