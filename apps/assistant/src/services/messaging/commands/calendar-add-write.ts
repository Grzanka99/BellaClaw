import { CalendarService } from "../../calendar";
import type { TCommand } from "./types";

export const calendarAddWriteCommand: TCommand = {
  name: "calendar_add-write",
  description:
    "Set the Google calendar the bot writes events to. The calendar must already be shared with the bot's service account with write access. Sending it again replaces the current one.",
  usage: "!calendar_add-write <calendarId>",
  handler: async (chatId, args) => {
    const calendarId = args.trim();

    if (calendarId.length === 0) {
      return "Usage: !calendar_add-write <calendarId>";
    }

    try {
      const calendar = await CalendarService.instance.setWriteCalendar(chatId, calendarId);
      return `Write calendar set: ${calendar.summary ?? calendar.calendarId}`;
    } catch (error) {
      return `Can't use that calendar: ${String(error)}`;
    }
  },
};
