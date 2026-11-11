import { arr, bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { EConfigKey } from "../../../settings/schema";
import { runAutomationOperation } from "../automation-errors";
import { parseAutomationNames, parseCronContent, runCronJobOperation } from "../cron-content";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SScheduleRecurringArgs = obj({
  name: str({
    description: "Unique recurring job name used to reference, update, or cancel it",
  }),
  pattern: str({ description: "Standard 5-field cron expression" }),
  reminderText: opt(
    str({ description: "Plain reminder text for a direct, non-generated reminder" }),
  ),
  reminderPromptData: opt(
    str({ description: "Structured reminder prompt data serialized as JSON" }),
  ),
  reminderFallbackText: opt(str({ description: "Fallback text required with reminderPromptData" })),
  taskPrompt: opt(str({ description: "Autonomous objective requiring tools at firing time" })),
  taskFallbackText: opt(str({ description: "Fallback text required with taskPrompt" })),
  automations: opt(
    arr(str(), {
      description:
        "Names of saved automations run in order at firing time; alone their text outputs are sent as written, with taskPrompt they feed the task",
    }),
  ),
  overwrite: opt(bool({ description: "Replace an existing recurring job with the same name" })),
});

export function validateScheduleRecurringArgs(args: Static<typeof SScheduleRecurringArgs>) {
  return {
    name: args.name,
    pattern: args.pattern,
    content: parseCronContent(args, true),
    automations: parseAutomationNames(args.automations) ?? [],
    overwrite: args.overwrite,
  };
}

export const scheduleRecurring = defineTool({
  name: "schedule-recurring",
  label: "Schedule recurring job",
  description:
    "Schedule a recurring reminder or autonomous task requiring tools using a 5-field cron pattern. Provide exactly one content mode: reminderText; reminderPromptData with reminderFallbackText; or taskPrompt with taskFallbackText. automations may be attached alone (their text outputs are sent as written) or with taskPrompt (their outputs feed the task).",
  schema: SScheduleRecurringArgs,
  instructions,
  mode: "sequential",
  logSafe: ["overwrite", "type", ["pattern", "cronPattern"], "nextRunAt", "timezone", "status"],
  privateErrors: true,
  execute: async (context, args) => {
    const { automations, ...validatedArgs } = validateScheduleRecurringArgs(args);
    const scope = requireChatId(context.chatId);
    const timezone = context.settings[EConfigKey.AiInstructionsTimezone];
    const automationIds = await runAutomationOperation(() =>
      AutomationService.instance.resolveNames(scope, automations),
    );

    return runCronJobOperation(() =>
      CronScheduler.instance.createRecurring({ ...validatedArgs, automationIds, scope, timezone }),
    );
  },
});
