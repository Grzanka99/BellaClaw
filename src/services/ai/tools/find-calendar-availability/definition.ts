import { createToolDefinition } from "../definition";
import { SFindCalendarAvailabilityArgs } from "./handler";

export const FIND_CALENDAR_AVAILABILITY_TOOL = "find-calendar-availability" as const;

export const findCalendarAvailabilityTool = createToolDefinition(
  FIND_CALENDAR_AVAILABILITY_TOOL,
  "Combine busy intervals across all configured calendars and optionally find free slots.",
  SFindCalendarAvailabilityArgs,
);
