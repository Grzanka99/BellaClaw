import { CalendarAdapter, ECalendarProvider } from "../../calendar";
import type { TCommand } from "./types";

export const calendarDiscoverCommand: TCommand = {
  name: "calendar_discover",
  description: "List available Google or iCloud calendars and IDs for calendar setup.",
  usage: "!calendar_discover PROVIDER",
  handler: async (_chatId, args) => {
    const provider = Object.values(ECalendarProvider).find(
      (candidate) => candidate === args.trim(),
    );
    if (provider === undefined) {
      return "Usage: !calendar_discover google|icloud";
    }
    try {
      const calendars = await CalendarAdapter.instance.discoverCalendars(provider);
      if (calendars.length === 0) {
        return "No calendars found. Check calendar sharing and accept any iCloud invitations.";
      }
      return JSON.stringify(calendars);
    } catch (error) {
      return `Can't list calendars: ${String(error)}`;
    }
  },
};
