import { EEventType } from "@bellaclaw/database";
import { COMMAND_CATALOG, type TCommandEntry } from "@bellaclaw/shared";
import type { TCalendarAccess } from "../calendar/types";
import type { TCommand } from "./types";

// outcome: the outcome of an added calendar
function createCalendarAddCommand(
  entry: TCommandEntry,
  reply: string,
  outcome: string,
  access: TCalendarAccess,
): TCommand {
  return {
    entry,
    handler: async (chatId, args, ctx) => {
      const calendarId = args.trim();

      if (calendarId.length === 0) {
        return { text: `Usage: ${entry.usage}`, state: "failed", outcome: "usage" };
      }

      try {
        const added = await ctx.request(
          EEventType.CalendarSourceAddRequested,
          { chatId, calendarId, access },
          {
            outcome: EEventType.CalendarSourceAdded,
            step: undefined,
            key: undefined,
            timeoutMs: undefined,
          },
        );
        return {
          text: `${reply}: ${added.payload.summary ?? added.payload.calendarId}`,
          state: "done",
          outcome,
        };
      } catch (error) {
        return {
          text: `Can't use that calendar: ${String(error)}`,
          state: "failed",
          outcome: "failed",
        };
      }
    },
  };
}

export const calendarAddReadCommand = createCalendarAddCommand(
  COMMAND_CATALOG["calendar_add-read"],
  "Read-only calendar added",
  "calendar added",
  "read",
);

export const calendarAddWriteCommand = createCalendarAddCommand(
  COMMAND_CATALOG["calendar_add-write"],
  "Write calendar set",
  "write calendar set",
  "write",
);
