import type { TCalendarAccess } from "../calendar/types";
import { EEventType } from "../events/catalog";
import type { TCommand } from "./types";

function createCalendarAddCommand(
  name: string,
  description: string,
  reply: string,
  access: TCalendarAccess,
): TCommand {
  const usage = `!${name} CALENDAR_ID`;

  return {
    name,
    description,
    usage,
    handler: async (chatId, args, ctx) => {
      const calendarId = args.trim();

      if (calendarId.length === 0) {
        return `Usage: ${usage}`;
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
        return `${reply}: ${added.payload.summary ?? added.payload.calendarId}`;
      } catch (error) {
        return `Can't use that calendar: ${String(error)}`;
      }
    },
  };
}

export const calendarAddReadCommand = createCalendarAddCommand(
  "calendar_add-read",
  "Add a Google calendar the bot reads events from. The calendar must already be shared with the bot's service account. It is always stored read-only.",
  "Read-only calendar added",
  "read",
);

export const calendarAddWriteCommand = createCalendarAddCommand(
  "calendar_add-write",
  "Set the Google calendar the bot writes events to. The calendar must already be shared with the bot's service account with write access. Sending it again replaces the current one.",
  "Write calendar set",
  "write",
);
