import assert from "node:assert/strict";
import test from "node:test";

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

  assert.ok(result);
  assert.equal(
    result.document.title,
    "IDEA-329756: Importing symlinked Gradle included build fails",
  );
  assert.equal(result.document.sourceKind, "issue-tracker");
  assert.match(result.document.body, /State: Open/);
  assert.match(result.document.body, /real path is a workaround/);
  assert.deepEqual(result.links, []);
});
