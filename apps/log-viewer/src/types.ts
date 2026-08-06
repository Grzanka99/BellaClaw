import {
  EBehaviorLogLevel,
  type TBehaviorLogSearchQuery,
  type TLogFilterOptions,
  type TLogPage,
  type TLogReaderError,
  type TPersistedBehaviorLogEvent,
  type TRecentTurn,
} from "@bellaclaw/behavior-logs";
import { z } from "zod";

export type TOption<T> = T | undefined;

export const SLogTimeRange = z.enum(["15m", "1h", "24h", "7d", "all"]);
export type TLogTimeRange = z.infer<typeof SLogTimeRange>;

export const SLogSearchQuery = z.object({
  q: z.string().optional().catch(undefined),
  range: SLogTimeRange.optional().catch(undefined),
  level: z
    .union([z.literal(""), z.enum(EBehaviorLogLevel)])
    .optional()
    .catch(undefined),
  success: z
    .union([z.literal(""), z.enum(["success", "failure"])])
    .optional()
    .catch(undefined),
  event: z.string().optional().catch(undefined),
  component: z.string().optional().catch(undefined),
  toolName: z.string().optional().catch(undefined),
  turnId: z.string().optional().catch(undefined),
  until: z.coerce.number().int().positive().optional().catch(undefined),
  beforeCreatedAt: z.coerce.number().int().nonnegative().optional().catch(undefined),
  beforeId: z.coerce.number().int().positive().optional().catch(undefined),
  live: z.literal("1").optional().catch(undefined),
});

export type TLogSearchQuery = TBehaviorLogSearchQuery;

export type {
  TLogFilterOptions,
  TLogPage,
  TLogReaderError,
  TPersistedBehaviorLogEvent,
  TRecentTurn,
};
