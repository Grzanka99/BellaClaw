import type { TAutomation } from "../../automation";

/** Saved-automation fields the agents may see without the script source. */
export function summarizeAutomation(automation: TAutomation) {
  return {
    name: automation.name,
    status: automation.status,
    failureCount: automation.failureCount,
    lastError: automation.lastError ?? undefined,
    allowedOrigins: automation.allowedOrigins,
    instructions: automation.instructions ?? undefined,
    outputCapBytes: automation.outputCapBytes,
  };
}
