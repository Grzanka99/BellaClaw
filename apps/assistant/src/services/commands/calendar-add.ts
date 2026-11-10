import { CalendarService } from "../calendar";
import type { TCalendar } from "../calendar/types";
import type { TCommand } from "./types";

function createCalendarAddCommand(
  name: string,
  description: string,
  reply: string,
  add: (chatId: string, calendarId: string) => Promise<TCalendar>,
): TCommand {
  const usage = `!${name} CALENDAR_ID`;

  return {
    name,
    description,
    usage,
    handler: async (chatId, args) => {
      const calendarId = args.trim();

      if (calendarId.length === 0) {
        return `Usage: ${usage}`;
      }

      try {
        const calendar = await add(chatId, calendarId);
        return `${reply}: ${calendar.summary ?? calendar.calendarId}`;
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
  (chatId, calendarId) => CalendarService.instance.addReadonlyCalendar(chatId, calendarId),
);

export const calendarAddWriteCommand = createCalendarAddCommand(
  "calendar_add-write",
  "Set the Google calendar the bot writes events to. The calendar must already be shared with the bot's service account with write access. Sending it again replaces the current one.",
  "Write calendar set",
  (chatId, calendarId) => CalendarService.instance.setWriteCalendar(chatId, calendarId),
);
