import type { automationDraftsTable, automationsTable } from "@bellaclaw/database";

export const MAX_CONSECUTIVE_AUTOMATION_FAILURES = 3;
export const DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES = 16_384;
export const MAX_AUTOMATION_OUTPUT_CAP_BYTES = 262_144;
/** A preview nobody saved within this time is dropped when the next draft is created. */
export const AUTOMATION_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export type TAutomation = typeof automationsTable.$inferSelect;
export type TAutomationDraft = typeof automationDraftsTable.$inferSelect;

export type TCreateAutomationDraftInput = {
  scope: string;
  name: string;
  instructions?: string;
  source: string;
  config: unknown;
  allowedOrigins: string[];
  outputCapBytes?: number;
};

export type TAutomationErrorCode =
  | "invalid-automation"
  | "draft-not-found"
  | "automation-not-found"
  | "unknown-automation";

/** An automation failure with a stable code; the message is safe to show the model. */
export class AutomationError extends Error {
  public readonly code: TAutomationErrorCode;

  constructor(code: TAutomationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
