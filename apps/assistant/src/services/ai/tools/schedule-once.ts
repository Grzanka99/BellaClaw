import { bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { CronScheduler } from "../../cron";
import { EConfigKey } from "../../settings/schema";
import {
  LOCAL_FIRE_AT_PATTERN,
  parseCronContent,
  parseLocalFireAt,
  runCronJobOperation,
} from "./cron-content";
import { defineTool, requireChatId } from "./define-tool";
import instructions from "./schedule-once.xml" with { type: "text" };

export const SScheduleOnceArgs = obj({
  name: str({
    description: "Unique one-time job name used to reference, update, or cancel it",
  }),
  fireAt: str({
    pattern: LOCAL_FIRE_AT_PATTERN,
    description: "Future local date-time in the owner's timezone, YYYY-MM-DDTHH:mm[:ss], no offset",
  }),
  reminderText: opt(
    str({ description: "Plain reminder text for a direct, non-generated reminder" }),
  ),
  reminderPromptData: opt(
    str({ description: "Structured reminder prompt data serialized as JSON" }),
  ),
  reminderFallbackText: opt(str({ description: "Fallback text required with reminderPromptData" })),
  taskPrompt: opt(str({ description: "Autonomous objective requiring tools at firing time" })),
  taskFallbackText: opt(str({ description: "Fallback text required with taskPrompt" })),
  overwrite: opt(bool({ description: "Replace an existing one-time job with the same name" })),
});

export function validateScheduleOnceArgs(args: Static<typeof SScheduleOnceArgs>, timezone: string) {
  return {
    name: args.name,
    content: parseCronContent(args, true),
    fireAt: parseLocalFireAt(args.fireAt, timezone),
    overwrite: args.overwrite,
  };
}

export const scheduleOnce = defineTool({
  name: "schedule-once",
  label: "Schedule one-time job",
  description:
    "Schedule a one-time reminder or autonomous task requiring tools. Provide exactly one content mode: reminderText; reminderPromptData with reminderFallbackText; or taskPrompt with taskFallbackText.",
  schema: SScheduleOnceArgs,
  instructions,
  mode: "sequential",
  logSafe: [
    "fireAt",
    "overwrite",
    "type",
    ["pattern", "cronPattern"],
    "nextRunAt",
    "timezone",
    "status",
  ],
  privateErrors: true,
  execute: async (context, args) => {
    const ownerTimezone = context.settings[EConfigKey.AiInstructionsTimezone];
    const validatedArgs = validateScheduleOnceArgs(args, ownerTimezone);
    const scope = requireChatId(context.chatId);

    return runCronJobOperation(() =>
      CronScheduler.instance.createOnce({ ...validatedArgs, scope, timezone: ownerTimezone }),
    );
  },
});
