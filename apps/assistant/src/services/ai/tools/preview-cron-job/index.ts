import type { TOption } from "@bellaclaw/shared";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { dryRunSavedAutomation } from "../../../automation/runner";
import { CronScheduler } from "../../../cron";
import { ECronJobType, type TCronJob, type TJobContent } from "../../../cron/types";
import type { TCronFiredPayload } from "../../../events/catalog";
import { parseCanonicalChatKey } from "../../../messaging/chat-key";
import { runCronJobAutomations } from "../../../scheduling/cron-automations";
import { EConfigKey } from "../../../settings/schema";
import { runAutomationOperation } from "../automation-errors";
import { absentIfBlank, parseAutomationNames } from "../cron-content";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

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

export const previewCronJob = defineTool({
  name: "preview-cron-job",
  label: "Preview cron job",
  description:
    "Dry-run a job with automations as if it fired now and return the exact message it would send. Nothing is delivered or saved and automation state is not changed. Base it on an existing job by name; taskPrompt and automations override the job's values.",
  schema: SPreviewCronJobArgs,
  instructions,
  // Saves nothing, so it can run alongside other calls.
  mode: "parallel",
  logSafe: [],
  privateErrors: true,
  execute: async (context, args, signal) => {
    const chatId = requireChatId(context.chatId);
    const timezone = context.settings[EConfigKey.AiInstructionsTimezone];
    const name = absentIfBlank(args.name);
    const taskPrompt = absentIfBlank(args.taskPrompt);
    const automationNames = parseAutomationNames(args.automations);
    let base: TOption<TCronJob>;

    if (name !== undefined) {
      base = await CronScheduler.instance.get(name, chatId);

      if (base === undefined) {
        throw new ToolError("job-not-found", `No job found with name: ${name}`);
      }
    }

    let content: TJobContent = { kind: "automations" };
    let automationIds: number[] = [];

    if (base !== undefined) {
      content = base.content;
      automationIds = base.automationIds;
    }

    if (taskPrompt !== undefined) {
      let fallback = "";

      if (content.kind === "task") {
        fallback = content.fallback;
      }

      content = { kind: "task", prompt: taskPrompt, fallback };
    }

    if (automationNames !== undefined) {
      automationIds = await runAutomationOperation(() =>
        AutomationService.instance.resolveNames(chatId, automationNames),
      );
    }

    if (automationIds.length > 0 && (content.kind === "text" || content.kind === "generated")) {
      throw new ToolError(
        "automations-without-task",
        "automations can only be combined with taskPrompt, not with reminders",
      );
    }

    if (automationIds.length === 0 && content.kind !== "task") {
      throw new ToolError(
        "missing-content",
        "Nothing to preview: provide automations or a taskPrompt",
      );
    }

    // NOTE: a job that is not saved yet has no id
    let ctx: TCronFiredPayload = {
      jobId: 0,
      name: "preview",
      scope: chatId,
      jobType: ECronJobType.OneTime,
      pattern: undefined,
      content,
      automationIds,
      nextRunAt: Date.now(),
      timezone,
    };

    if (base !== undefined) {
      ctx = {
        ...ctx,
        jobId: base.id,
        name: base.name,
        jobType: base.type,
        pattern: base.pattern ?? undefined,
        timezone: base.timezone ?? timezone,
      };
    }

    const result = await runCronJobAutomations(
      ctx,
      parseCanonicalChatKey(chatId)?.platform,
      // Dry runs must not reach MCP servers, whose tools can have side effects.
      {
        runScheduledTask: (runArgs) => {
          return context.runScheduledTask({ ...runArgs, withoutMcp: true });
        },
      },
      (automation, options) => dryRunSavedAutomation(automation, { ...options, signal }),
      context.trace,
    );
    let message: TOption<string>;
    let note: TOption<string>;

    if (result.text !== undefined && result.text.trim().length > 0) {
      message = result.text;
    } else if (content.kind !== "task") {
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
  },
});
