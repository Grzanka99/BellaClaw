import { createToolDefinition } from "../definition";
import { SListCalendarsArgs } from "./handler";

export const LIST_CALENDARS_TOOL = "list-calendars";

export const listCalendarsTool = createToolDefinition(
  LIST_CALENDARS_TOOL,
  "List configured calendars with stored access, live Google summaries, and per-source errors.",
  SListCalendarsArgs,
);
