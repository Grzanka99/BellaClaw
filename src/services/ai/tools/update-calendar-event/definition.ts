import { createToolDefinition } from "../definition";
import { SUpdateCalendarEventArgs } from "./handler";

export const UPDATE_CALENDAR_EVENT_TOOL = "update-calendar-event" as const;

export const updateCalendarEventTool = createToolDefinition(
  UPDATE_CALENDAR_EVENT_TOOL,
  "Patch one resolved event using an explicit occurrence, following, or series scope.",
  SUpdateCalendarEventArgs,
);
