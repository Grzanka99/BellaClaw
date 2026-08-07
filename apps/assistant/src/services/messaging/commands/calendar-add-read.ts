import { CalendarService } from "../../calendar";
import type { TCommand } from "./types";

export const calendarAddReadCommand: TCommand = {
  name: "calendar_add-read",
  description:
    "Add a Google calendar the bot reads events from. The calendar must already be shared with the bot's service account. It is always stored read-only.",
  usage: "!calendar_add-read <calendarId>",
  handler: async (chatId, args) => {
    const calendarId = args.trim();

    if (calendarId.length === 0) {
      return "Usage: !calendar_add-read <calendarId>";
    }

    try {
      const calendar = await CalendarService.instance.addReadonlyCalendar(chatId, calendarId);
      return `Read-only calendar added: ${calendar.summary ?? calendar.calendarId}`;
    } catch (error) {
      return `Can't use that calendar: ${String(error)}`;
    }
  },
};
