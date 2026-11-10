import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { CalendarService } from "../../../calendar";
import { EConfigKey } from "../../../settings/schema";
import { defineTool, requireChatId } from "../define-tool";
import { validateListCalendarEventsArgs } from "../list-calendar-events";
import instructions from "./instructions.xml" with { type: "text" };

export const findCalendarAvailability = defineTool({
  name: "find-calendar-availability",
  label: "Find calendar availability",
  description:
    "Combine busy intervals across all configured calendars and optionally find free slots.",
  schema: obj({
    timeMin: str({
      format: "date-time",
      description: "Inclusive search-window start as RFC 3339 with an explicit timezone",
    }),
    timeMax: str({
      format: "date-time",
      description: "Exclusive search-window end as RFC 3339 with an explicit timezone",
    }),
    durationMinutes: opt(
      int({
        minimum: 1,
        description: "Requested free-slot duration; omit when only checking conflicts",
      }),
    ),
  }),
  instructions,
  mode: "parallel",
  logSafe: [],
  execute: async (context, args, signal) => {
    const userId = requireChatId(context.chatId);
    validateListCalendarEventsArgs(args);
    return CalendarService.instance.findAvailability({
      ...args,
      userId,
      timezone: context.settings[EConfigKey.AiInstructionsTimezone],
      signal,
    });
  },
});
