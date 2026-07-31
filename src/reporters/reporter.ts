import type { CoordinatorOutput } from "../core/schema.js";

/** A Reporter is where results go. The core produces a mode-agnostic result; the
 * Reporter decides how to render it. */
export interface Reporter {
  /** CI-only break-glass check; local reporters omit it (treated as false). */
  // @ref LLP 0008#terminal-reporter [constrained-by] — optional and CI-only by contract; a missing method is treated as false, keeping local mode's Reporter contract simpler than CI's
  checkBreakGlass?(): Promise<boolean>;
  report(review: CoordinatorOutput): Promise<void>;
}
