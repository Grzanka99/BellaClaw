import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { CalendarService } from "../../calendar";
import { defineTool, requireChatId } from "./define-tool";
import instructions from "./delete-calendar-event.xml" with { type: "text" };

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
  execute: async (context, args, signal) => {
    const userId = requireChatId(context.chatId);
    await CalendarService.instance.deleteEvent({ ...args, userId, signal });
    return { success: true };
  },
});
