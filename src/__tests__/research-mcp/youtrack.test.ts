import { expect, test } from "bun:test";

import { extractYouTrackIssue } from "../../research-mcp/youtrack.js";

test("YouTrack extraction returns bounded issue evidence with provenance", () => {
  const result = extractYouTrackIssue(
    JSON.stringify({
      idReadable: "IDEA-329756",
      summary: "Importing symlinked Gradle included build fails",
      description: "The command-line build succeeds but IDE import fails.",
      customFields: [{ name: "State", value: { name: "Open" } }],
      comments: [{ text: "Using a real path is a workaround." }],
    }),
    "https://youtrack.jetbrains.com/issue/IDEA-329756",
    { provider: "jetbrains-issues", sourceKind: "issue-tracker" },
  );

  expect(result).not.toBeNull();
  expect(result?.document.title).toBe(
    "IDEA-329756: Importing symlinked Gradle included build fails",
  );
  expect(result?.document.sourceKind).toBe("issue-tracker");
  expect(result?.document.body).toMatch(/State: Open/);
  expect(result?.document.body).toMatch(/real path is a workaround/);
  expect(result?.links).toEqual([]);
});
