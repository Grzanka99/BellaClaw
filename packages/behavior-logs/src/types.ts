import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";

export enum EBehaviorLogLevel {
  Info = "info",
  Warning = "warning",
  Error = "error",
  Message = "message",
}

export type TBehaviorTraceContext = {
  turnId: string;
  chatId: TOption<string>;
  platform: TOption<string>;
};

export type TBehaviorMetadataValue =
  | string
  | number
  | boolean
  | null
  | TBehaviorMetadataValue[]
  | { [key: string]: TBehaviorMetadataValue };

export type TBehaviorMetadata = {
  [key: string]: TBehaviorMetadataValue;
};

export const SBehaviorMetadataValue: z.ZodType<TBehaviorMetadataValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(SBehaviorMetadataValue),
    z.record(z.string(), SBehaviorMetadataValue),
  ]),
);

export const SBehaviorMetadata = z.record(z.string(), SBehaviorMetadataValue);

export const SBehaviorLogEvent = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  level: z.enum(EBehaviorLogLevel),
  event: z.string(),
  turnId: z.string(),
  chatId: z.string().nullable(),
  platform: z.string().nullable(),
  component: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  purpose: z.string().nullable(),
  toolName: z.string().nullable(),
  success: z.boolean().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  summary: z.string().nullable(),
  metadata: SBehaviorMetadata,
  error: z.string().nullable(),
});

export type TBehaviorLogEvent = z.infer<typeof SBehaviorLogEvent>;

export type TBehaviorLogInput = {
  trace: TBehaviorTraceContext;
  event: string;
  component: string;
  level?: EBehaviorLogLevel;
  provider?: TOption<string>;
  model?: TOption<string>;
  purpose?: TOption<string>;
  toolName?: TOption<string>;
  success?: TOption<boolean>;
  durationMs?: TOption<number>;
  summary?: TOption<string>;
  metadata?: TBehaviorMetadata;
  error?: TOption<string>;
};

export const SStoredBehaviorLogRow = z.object({
  id: z.number(),
  createdAt: z.number(),
  schemaVersion: z.number(),
  level: z.enum(EBehaviorLogLevel),
  event: z.string(),
  turnId: z.string(),
  chatId: z.string().nullable(),
  platform: z.string().nullable(),
  component: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  purpose: z.string().nullable(),
  toolName: z.string().nullable(),
  success: z.number().nullable(),
  durationMs: z.number().nullable(),
  summary: z.string().nullable(),
  metadataJson: z.string(),
  error: z.string().nullable(),
});

export type TStoredBehaviorLogRow = z.infer<typeof SStoredBehaviorLogRow>;

export type TPersistedBehaviorLogEvent = Omit<TBehaviorLogEvent, "schemaVersion"> & {
  id: number;
  createdAtMs: number;
  schemaVersion: number;
};
