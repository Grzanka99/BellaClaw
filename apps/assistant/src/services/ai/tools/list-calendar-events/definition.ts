import { createToolDefinition } from "../definition";
import { SListCalendarEventsArgs } from "./handler";

export const LIST_CALENDAR_EVENTS_TOOL = "list-calendar-events";

export const listCalendarEventsTool = createToolDefinition(
  LIST_CALENDAR_EVENTS_TOOL,
  "List full event details across every configured calendar in a required date-time range.",
  SListCalendarEventsArgs,
);
