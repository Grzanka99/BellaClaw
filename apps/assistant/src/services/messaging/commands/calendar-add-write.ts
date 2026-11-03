import { CalendarAdapter, ECalendarProvider } from "../../calendar";
import type { TCommand } from "./types";

export const calendarAddWriteCommand: TCommand = {
  name: "calendar_add-write",
  description:
    "Set the Google or iCloud calendar the bot writes events to. It requires write access. Replaces the one writable calendar for this chat.",
  usage: "!calendar_add-write PROVIDER CALENDAR_ID",
  handler: async (chatId, args) => {
    const [providerName, calendarId, extra] = args
      .trim()
      .split(" ")
      .filter((value) => value.length > 0);
    const provider = Object.values(ECalendarProvider).find(
      (candidate) => candidate === providerName,
    );

    if (provider === undefined || !calendarId || extra !== undefined) {
      return "Usage: !calendar_add-write PROVIDER CALENDAR_ID";
    }

    try {
      const calendar = await CalendarAdapter.instance.setWriteCalendar(
        chatId,
        provider,
        calendarId,
      );
      return `Write calendar set: ${calendar.summary ?? calendar.calendarId}`;
    } catch (error) {
      return `Can't use that calendar: ${String(error)}`;
    }
  },
};
