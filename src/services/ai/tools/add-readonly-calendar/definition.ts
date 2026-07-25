import { createToolDefinition } from "../definition";
import { SAddReadonlyCalendarArgs } from "./handler";

export const ADD_READONLY_CALENDAR_TOOL = "add-readonly-calendar" as const;

export const addReadonlyCalendarTool = createToolDefinition(
  ADD_READONLY_CALENDAR_TOOL,
  "Validate and add an explicitly supplied Google calendar as a read-only source.",
  SAddReadonlyCalendarArgs,
);
