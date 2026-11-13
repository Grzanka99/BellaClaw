import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { EEventType } from "../../../events/catalog";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SDeleteCalendarEventArgs = obj({
  eventId: str({ minLength: 1, description: "Resolved writable-calendar event ID" }),
  scope: oneOf(["occurrence", "following", "series"]),
});

export const deleteCalendarEvent = defineTool({
  name: "delete-calendar-event",
  label: "Delete calendar event",
  description:
    "Delete one resolved event using an explicit occurrence, following, or series scope.",
  schema: SDeleteCalendarEventArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  execute: async (context, args) => {
    const chatId = requireChatId(context.chatId);
    await context.events.request(
      EEventType.CalendarEventDeleteRequested,
      { chatId, eventId: args.eventId, scope: args.scope },
      {
        outcome: EEventType.CalendarEventDeleted,
        step: undefined,
        key: chatId,
        timeoutMs: undefined,
      },
    );
    return { success: true };
  },
});
