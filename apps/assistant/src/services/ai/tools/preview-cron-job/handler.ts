import type { TOption } from "@bellaclaw/shared";
import { arr, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { runCronJobAutomations } from "../../../../handlers/cron-automations";
import type { TScheduledTaskAi } from "../../../../handlers/generate-reminder-text";
import { ECronJobType, type TCronJob, type TCronJobContext } from "../../../../lib/cron-engine";
import { AutomationService } from "../../../automation";
import {
  dryRunSavedAutomation,
  type EAutomationRunOutcome,
  type TAutomationRunOptions,
} from "../../../automation/runner";
import { CronSingleton } from "../../../cron";
import { absentIfBlank, normalizeCronContentFields } from "../cron-content";

export const SPreviewCronJobArgs = obj({
  name: opt(
    str({ description: "Existing job to preview; omit to preview a job that is not saved yet" }),
  ),
  taskPrompt: opt(
    str({ description: "Task objective to preview instead of the job's current taskPrompt" }),
  ),
  automations: opt(
    arr(str(), {
      description:
        "Ordered saved automation names to preview instead of the job's current automations",
    }),
  ),
});

export type TPreviewCronJobArgs = Static<typeof SPreviewCronJobArgs>;

export type TPreviewCronJobResult = {
  /** The message the job would send; absent when nothing would be sent. */
  message: TOption<string>;
  note: TOption<string>;
  automations: Array<{
    name: string;
    outcome: EAutomationRunOutcome;
    error: TOption<string>;
  }>;
};

/**
 * Runs the job's automations without recording anything and produces the
 * message through the same path as a real firing, without delivering it.
 */
export async function handlePreviewCronJob(
  chatId: string,
  args: TPreviewCronJobArgs,
  ai: TScheduledTaskAi,
  options: TAutomationRunOptions,
): Promise<TPreviewCronJobResult> {
  const name = absentIfBlank(args.name);
  const overrides = normalizeCronContentFields(args);
  let base: TOption<TCronJob>;

  if (name !== undefined) {
    base = await CronSingleton.instance.get(name, chatId);

    if (base === undefined) {
      throw new Error(`No job found with name: ${name}`);
    }
  }

  let taskPrompt = overrides.taskPrompt;
  let hasReminderContent = false;
  let automationIds: number[] = [];

  if (base !== undefined) {
    automationIds = base.automationIds;

    if (taskPrompt === undefined) {
      taskPrompt = base.taskPrompt;
      hasReminderContent = base.reminderText !== undefined || base.reminderPromptData !== undefined;
    }
  }

  if (overrides.automations !== undefined) {
    automationIds = await AutomationService.instance.resolveNames(chatId, overrides.automations);
  }

  if (automationIds.length > 0 && hasReminderContent) {
    throw new Error("automations can only be combined with taskPrompt, not with reminders");
  }

  if (automationIds.length === 0 && taskPrompt === undefined) {
    throw new Error("Nothing to preview: provide automations or a taskPrompt");
  }

  const now = new Date();
  const ctx: TCronJobContext = {
    name: base?.name ?? "preview",
    scope: chatId,
    group: base?.group,
    type: base?.type ?? ECronJobType.OneTime,
    pattern: base?.pattern,
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: undefined,
    taskPrompt,
    taskFallbackText: base?.taskFallbackText ?? "",
    automationIds,
    lastRunAt: base?.lastRunAt,
    nextRunAt: now,
    createdAt: base?.createdAt ?? now,
    timezone: base?.timezone ?? options.timezone,
  };

  const result = await runCronJobAutomations(
    ctx,
    chatId,
    { runScheduledTask: (runArgs) => ai.runScheduledTask({ ...runArgs, withoutMcp: true }) },
    (automation, runOptions) => dryRunSavedAutomation(automation, { ...options, ...runOptions }),
    options.trace,
  );
  let message: TOption<string>;
  let note: TOption<string>;

  if (result.text !== undefined && result.text.trim().length > 0) {
    message = result.text;
  } else if (taskPrompt === undefined) {
    note = "Nothing would be sent: no automation returned text.";
  } else {
    note = "Nothing would be sent: the task produced no text and the job has no fallback text.";
  }

  return {
    message,
    note,
    automations: result.reports.map((report) => ({
      name: report.name,
      outcome: report.outcome,
      error: report.error,
    })),
  };
}
