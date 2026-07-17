import { z } from "zod";
import {
  EBehaviorLogLevel,
  type TPersistedBehaviorLogEvent,
} from "../../services/app-logger/types";
import type { TOption } from "../../types";

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

export type TLogSearchQuery = {
  q: TOption<string>;
  range: TLogTimeRange;
  level: TOption<EBehaviorLogLevel>;
  success: TOption<"success" | "failure">;
  event: TOption<string>;
  component: TOption<string>;
  toolName: TOption<string>;
  turnId: TOption<string>;
  until: number;
  beforeCreatedAt: TOption<number>;
  beforeId: TOption<number>;
  live: boolean;
};

export type TLogReaderError = {
  kind: "missing" | "schema" | "unavailable";
  message: string;
  detail: string;
  dbPath: string;
};

export type TLogReaderResult<T> =
  | { success: true; data: T }
  | { success: false; error: TLogReaderError };

export type TLogFilterOptions = {
  events: string[];
  components: string[];
  toolNames: string[];
};

export type TRecentTurn = {
  turnId: string;
  latestCreatedAtMs: number;
  eventCount: number;
  hasFailure: boolean;
};

export type TLogPage = {
  events: TPersistedBehaviorLogEvent[];
  hasMore: boolean;
  recentTurns: TRecentTurn[];
  filters: TLogFilterOptions;
};

export type TTurnPage = {
  events: TPersistedBehaviorLogEvent[];
  startedAtMs: number;
  latestCreatedAtMs: number;
  hasFailure: boolean;
};
