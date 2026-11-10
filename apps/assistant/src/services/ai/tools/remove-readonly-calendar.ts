import { obj, str } from "@earendil-works/pi-schema";
import { CalendarService } from "../../calendar";
import { defineTool, requireChatId } from "./define-tool";
import instructions from "./remove-readonly-calendar.xml" with { type: "text" };

export const removeReadonlyCalendar = defineTool({
  name: "remove-readonly-calendar",
  label: "Remove read-only calendar",
  description: "Remove a configured read-only calendar. The writable calendar cannot be removed.",
  schema: obj({
    calendarId: str({
      minLength: 1,
      description: "Configured read-only Google calendar ID to remove",
    }),
  }),
  instructions,
  mode: "sequential",
  execute: async (context, args) => {
    await CalendarService.instance.removeReadonlyCalendar(
      requireChatId(context.chatId),
      args.calendarId,
    );
    return { success: true };
  },
});
