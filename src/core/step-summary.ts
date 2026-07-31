// @ref LLP 0002#run-log-and-observability-sinks [implements] — swallows append errors; observability must never break a review
import { appendFile } from "node:fs/promises";

/**
 * Append a markdown section to the GitHub Actions step summary, so a run's
 * output survives on the workflow-run page after the PR comment is upserted
 * away by the next run. No-op outside Actions (GITHUB_STEP_SUMMARY unset).
 */
export async function appendStepSummary(markdown: string): Promise<void> {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  try {
    await appendFile(file, `${markdown}\n\n`, "utf8");
  } catch {
    // Observability must never break a review.
  }
}
