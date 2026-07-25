import { createToolDefinition } from "../definition";
import { SDeleteCalendarEventArgs } from "./handler";

export const DELETE_CALENDAR_EVENT_TOOL = "delete-calendar-event";

export const deleteCalendarEventTool = createToolDefinition(
  DELETE_CALENDAR_EVENT_TOOL,
  "Delete one resolved event using an explicit occurrence, following, or series scope.",
  SDeleteCalendarEventArgs,
);
