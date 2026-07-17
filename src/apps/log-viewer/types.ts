import { z } from "zod";
import {
  EBehaviorLogLevel,
  type TPersistedBehaviorLogEvent,
} from "../../services/app-logger/types";
import type { TOption } from "../../types";

export const SLogTimeRange = z.enum(["15m", "1h", "24h", "7d", "all"]);
export type TLogTimeRange = z.infer<typeof SLogTimeRange>;

export const SLogSearchQuery = z.object({
  q: z.string().optional(),
  range: SLogTimeRange.optional(),
  level: z.union([z.literal(""), z.enum(EBehaviorLogLevel)]).optional(),
  success: z.union([z.literal(""), z.enum(["success", "failure"])]).optional(),
  event: z.string().optional(),
  component: z.string().optional(),
  toolName: z.string().optional(),
  turnId: z.string().optional(),
  until: z.coerce.number().int().positive().optional(),
  beforeCreatedAt: z.coerce.number().int().nonnegative().optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  live: z.literal("1").optional(),
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
