import { obj } from "@earendil-works/pi-schema";
import { CalendarService } from "../../calendar";
import { defineTool, requireChatId } from "./define-tool";
import instructions from "./list-calendars.xml" with { type: "text" };

export const listCalendars = defineTool({
  name: "list-calendars",
  label: "List calendars",
  description:
    "List configured calendars with stored access, live Google summaries, and per-source errors.",
  schema: obj({}),
  instructions,
  mode: "parallel",
  execute: async (context, _args, signal) => {
    return CalendarService.instance.listCalendars(requireChatId(context.chatId), signal);
  },
});
