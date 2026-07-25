import { createToolDefinition } from "../definition";
import { SRemoveReadonlyCalendarArgs } from "./handler";

export const REMOVE_READONLY_CALENDAR_TOOL = "remove-readonly-calendar" as const;

export const removeReadonlyCalendarTool = createToolDefinition(
  REMOVE_READONLY_CALENDAR_TOOL,
  "Remove a configured read-only calendar. The writable calendar cannot be removed.",
  SRemoveReadonlyCalendarArgs,
);
