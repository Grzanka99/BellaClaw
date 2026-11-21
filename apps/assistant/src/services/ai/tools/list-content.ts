import type { TListSnapshot } from "@bellaclaw/shared";
import { formatLocalDateTime } from "./cron-content";

/**
 * The lists as the model sees them: endsAt is local wall time in the owner's timezone, and
 * expired and allDone are worked out here so the model need not compare times or count items.
 */
export function toListsResult(lists: TListSnapshot[], timezone: string, now: number) {
  return {
    timezone,
    lists: lists.map((list) => {
      let endsAt: string | null = null;

      if (list.expiresAt !== null) {
        endsAt = formatLocalDateTime(list.expiresAt, timezone);
      }

      return {
        id: list.id,
        name: list.name,
        endsAt,
        expired: list.expiresAt !== null && list.expiresAt <= now,
        allDone: list.items.length > 0 && list.items.every((item) => item.done),
        items: list.items,
      };
    }),
  };
}
