import { obj, str } from "@earendil-works/pi-schema";
import { EEventType } from "../../../events/catalog";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

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
  logSafe: [],
  execute: async (context, args) => {
    const chatId = requireChatId(context.chatId);
    await context.events.request(
      EEventType.CalendarSourceRemoveRequested,
      { chatId, calendarId: args.calendarId },
      {
        outcome: EEventType.CalendarSourceRemoved,
        step: undefined,
        key: chatId,
        timeoutMs: undefined,
      },
    );
    return { success: true };
  },
});
