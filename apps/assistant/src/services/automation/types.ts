import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";

export const MAX_CONSECUTIVE_AUTOMATION_FAILURES = 3;
export const DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES = 16_384;
export const MAX_AUTOMATION_OUTPUT_CAP_BYTES = 262_144;

export enum EAutomationStatus {
  Active = "active",
  Paused = "paused",
}

const SJsonText = z.string().transform((value, ctx) => {
  try {
    const json: unknown = JSON.parse(value);
    return json;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid JSON column" });
    return z.NEVER;
  }
});

const SAllowedOriginsColumn = SJsonText.pipe(z.array(z.string()));

const SNullableText = z
  .string()
  .nullable()
  .transform((value) => value ?? undefined);

const STimestamp = z.number().transform((value) => new Date(value));

export const SAutomationDraftRow = z.object({
  id: z.number(),
  scope: z.string(),
  name: z.string(),
  instructions: SNullableText,
  source: z.string(),
  config: SJsonText,
  allowedOrigins: SAllowedOriginsColumn,
  outputCapBytes: z.number(),
  createdAt: STimestamp,
});

export const SAutomationRow = SAutomationDraftRow.extend({
  state: SJsonText.nullable().transform((value) => value ?? undefined),
  status: z.enum(EAutomationStatus),
  failureCount: z.number(),
  lastError: SNullableText,
  updatedAt: STimestamp,
});

export type TAutomation = {
  id: number;
  scope: string;
  name: string;
  instructions: TOption<string>;
  source: string;
  config: unknown;
  allowedOrigins: string[];
  outputCapBytes: number;
  state: TOption<unknown>;
  status: EAutomationStatus;
  failureCount: number;
  lastError: TOption<string>;
  createdAt: Date;
  updatedAt: Date;
};

export type TAutomationDraft = {
  id: number;
  scope: string;
  name: string;
  instructions: TOption<string>;
  source: string;
  config: unknown;
  allowedOrigins: string[];
  outputCapBytes: number;
  createdAt: Date;
};

export type TCreateAutomationDraftInput = {
  scope: string;
  name: string;
  instructions?: string;
  source: string;
  config: unknown;
  allowedOrigins: string[];
  outputCapBytes?: number;
};
