import { createToolDefinition } from "../definition";
import { SCreateCalendarEventArgs } from "./handler";

export const CREATE_CALENDAR_EVENT_TOOL = "create-calendar-event";

export const createCalendarEventTool = createToolDefinition(
  CREATE_CALENDAR_EVENT_TOOL,
  "Create a timed, all-day, or recurring event on the trusted writable calendar.",
  SCreateCalendarEventArgs,
);
