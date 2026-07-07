import type { TOption } from "../../types";
import type { TBehaviorMetadata, TPersistedBehaviorLogEvent, TStoredBehaviorLogRow } from "./types";

export function normalizeDurationMs(value: TOption<number>): TOption<number> {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    return undefined;
  }

  if (value < 0) {
    return 0;
  }

  return Math.round(value);
}

export function booleanToSqlite(value: boolean | null): number | null {
  if (value === null) {
    return null;
  }

  if (value) {
    return 1;
  }

  return 0;
}

export function sqliteToBoolean(value: number | null): TOption<boolean> {
  if (value === null) {
    return undefined;
  }

  return value === 1;
}

export function normalizeRowId(value: number | bigint): number {
  if (typeof value === "bigint") {
    return Number(value);
  }

  return value;
}

export function rowToEvent(
  row: TStoredBehaviorLogRow,
  metadata: TBehaviorMetadata,
): TPersistedBehaviorLogEvent {
  return {
    id: row.id,
    createdAtMs: row.createdAt,
    schemaVersion: row.schemaVersion,
    createdAt: new Date(row.createdAt).toISOString(),
    level: row.level,
    event: row.event,
    turnId: row.turnId,
    chatId: row.chatId,
    platform: row.platform,
    component: row.component,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    toolName: row.toolName,
    success: sqliteToBoolean(row.success) ?? null,
    durationMs: row.durationMs,
    summary: row.summary,
    metadata,
    error: row.error,
  };
}
