import { CalendarAdapter, ECalendarProvider } from "../../calendar";
import type { TCommand } from "./types";

export const calendarAddReadCommand: TCommand = {
  name: "calendar_add-read",
  description:
    "Add a Google or iCloud calendar the bot reads events from. It requires access to event details and is stored read-only.",
  usage: "!calendar_add-read PROVIDER CALENDAR_ID",
  handler: async (chatId, args) => {
    const [providerName, calendarId, extra] = args
      .trim()
      .split(" ")
      .filter((value) => value.length > 0);
    const provider = Object.values(ECalendarProvider).find(
      (candidate) => candidate === providerName,
    );

    if (provider === undefined || !calendarId || extra !== undefined) {
      return "Usage: !calendar_add-read PROVIDER CALENDAR_ID";
    }

    try {
      const calendar = await CalendarAdapter.instance.addReadonlyCalendar(
        chatId,
        provider,
        calendarId,
      );
      return `Read-only calendar added: ${calendar.summary ?? calendar.calendarId}`;
    } catch (error) {
      return `Can't use that calendar: ${String(error)}`;
    }
  },
};
