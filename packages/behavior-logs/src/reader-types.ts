import type { TOption } from "./option";
import type { EBehaviorLogLevel, TPersistedBehaviorLogEvent } from "./types";

export type TLogTimeRange = "15m" | "1h" | "24h" | "7d" | "all";

export type TBehaviorLogSearchQuery = {
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
