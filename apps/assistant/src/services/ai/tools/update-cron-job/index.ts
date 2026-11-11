import { arr, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { ECronJobType } from "../../../cron/types";
import { EConfigKey } from "../../../settings/schema";
import { runAutomationOperation } from "../automation-errors";
import {
  absentIfBlank,
  parseAutomationNames,
  parseCronContent,
  parseLocalFireAt,
  runCronJobOperation,
} from "../cron-content";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SUpdateCronJobArgs = obj({
  name: str({ description: "Unique name of the existing cron job to update" }),
  pattern: opt(
    str({
      description:
        "New 5-field cron expression for a recurring job; omit to keep the current schedule",
    }),
  ),
  fireAt: opt(
    str({
      description:
        "New future local date-time for a one-time job in the owner's timezone, YYYY-MM-DDTHH:mm[:ss]; omit for recurring jobs and to keep the current time",
    }),
  ),
  reminderText: opt(str({ description: "New plain reminder text" })),
  reminderPromptData: opt(str({ description: "New structured reminder prompt data" })),
  reminderFallbackText: opt(str({ description: "Fallback text required with reminderPromptData" })),
  taskPrompt: opt(str({ description: "New autonomous web task objective" })),
  taskFallbackText: opt(str({ description: "Fallback text required with taskPrompt" })),
  automations: opt(
    arr(str(), {
      description:
        "New ordered list of saved automation names; replaces the current list, an empty list removes all automations; omit to keep them",
    }),
  ),
});

export function validateUpdateCronJobArgs(args: Static<typeof SUpdateCronJobArgs>) {
  const pattern = absentIfBlank(args.pattern);
  const fireAt = absentIfBlank(args.fireAt);

  if (pattern !== undefined && fireAt !== undefined) {
    throw new ToolError(
      "conflicting-schedule-fields",
      "Provide either pattern or fireAt, not both",
    );
  }

  return {
    name: args.name,
    pattern,
    fireAt,
    content: parseCronContent(args, false),
    automations: parseAutomationNames(args.automations),
  };
}

export const updateCronJob = defineTool({
  name: "update-cron-job",
  label: "Update cron job",
  description:
    "Update an existing reminder or scheduled task by name. Use pattern only for recurring jobs and fireAt only for one-time jobs. A supplied content mode replaces the previous mode. A supplied automations list replaces the attached automations; an empty list removes them. Omit pattern and fireAt for content-only updates.",
  schema: SUpdateCronJobArgs,
  instructions,
  mode: "sequential",
  logSafe: ["fireAt", "type", ["pattern", "cronPattern"], "nextRunAt", "timezone", "status"],
  privateErrors: true,
  execute: async (context, parsedArgs) => {
    const chatId = requireChatId(context.chatId);
    const validatedArgs = validateUpdateCronJobArgs(parsedArgs);
    const existing = await CronScheduler.instance.get(validatedArgs.name, chatId);

    if (existing === undefined) {
      throw new ToolError("job-not-found", `No job found with name: ${validatedArgs.name}`);
    }

    const content = validatedArgs.content ?? existing.content;
    const automations = validatedArgs.automations;
    let automationIds = existing.automationIds;

    if (automations !== undefined) {
      automationIds = await runAutomationOperation(() =>
        AutomationService.instance.resolveNames(chatId, automations),
      );
    }

    if (automationIds.length > 0 && (content.kind === "text" || content.kind === "generated")) {
      throw new ToolError(
        "automations-without-task",
        "automations can only be combined with taskPrompt, not with reminders; to turn this job into a reminder also pass automations: [] to remove its automations",
      );
    }

    if (automationIds.length === 0 && content.kind === "automations") {
      throw new ToolError(
        "missing-content",
        "Provide reminderText, reminderPromptData, or taskPrompt, or attach automations; removing all automations would leave this job without content",
      );
    }

    if (existing.type === ECronJobType.Recurring) {
      if (validatedArgs.fireAt !== undefined) {
        throw new ToolError(
          "fire-at-on-recurring-job",
          "fireAt can only update one-time reminders; omit fireAt for this recurring reminder and use pattern only to change its schedule",
        );
      }

      const pattern = validatedArgs.pattern ?? existing.pattern;

      if (pattern === null) {
        throw new Error("Existing recurring reminder has no pattern");
      }

      return runCronJobOperation(() =>
        CronScheduler.instance.createRecurring({
          name: existing.name,
          scope: chatId,
          pattern,
          content,
          automationIds,
          overwrite: true,
          timezone: existing.timezone ?? undefined,
        }),
      );
    }

    if (validatedArgs.pattern !== undefined) {
      throw new ToolError(
        "pattern-on-one-time-job",
        "pattern can only update recurring reminders; omit pattern for this one-time reminder and use fireAt only to change its time",
      );
    }

    let fireAt = existing.nextRunAt;

    if (validatedArgs.fireAt !== undefined) {
      fireAt = parseLocalFireAt(
        validatedArgs.fireAt,
        context.settings[EConfigKey.AiInstructionsTimezone],
      );
    }

    return runCronJobOperation(() =>
      CronScheduler.instance.createOnce({
        name: existing.name,
        scope: chatId,
        fireAt,
        content,
        automationIds,
        overwrite: true,
        timezone: existing.timezone ?? undefined,
      }),
    );
  },
});
