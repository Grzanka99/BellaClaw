import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import { ECronJobType } from "../../../lib/cron-engine";
import { fetchWeb, searchWeb } from "../../../lib/web";
import type { TOption } from "../../../types";
import { CronSingleton } from "../../cron";
import { Memory } from "../../memory";
import { sortByImportanceAndDates } from "../../memory/sort";
import { invalidateMessageHandlerInstructions } from "../../message-handler/instructions";
import { SettingsService } from "../../settings";
import { ConfigValidators, EConfigKey, type TConfigRecord } from "../../settings/schema";
import { getAiModelIds } from "../providers/registry";
import { EAiProvider, EModelPurpose } from "../types";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "./define-message-importance/definition";
import { SDefineMessageImportance } from "./define-message-importance/handler";
import { GET_SETTINGS_TOOL } from "./get-settings/definition";
import { SGetSettingsArgs } from "./get-settings/handler";
import { LIST_CRON_JOBS_TOOL } from "./list-cron-jobs/definition";
import { SListCronJobsArgs } from "./list-cron-jobs/handler";
import { SCHEDULE_ONCE_TOOL } from "./schedule-once/definition";
import {
  SScheduleOnceArgs,
  type TScheduleOnceArgs,
  validateScheduleOnceArgs,
} from "./schedule-once/handler";
import { SCHEDULE_RECURRING_TOOL } from "./schedule-recurring/definition";
import {
  SScheduleRecurringArgs,
  type TScheduleRecurringArgs,
  validateScheduleRecurringArgs,
} from "./schedule-recurring/handler";
import { SEARCH_MEMORY_TOOL } from "./search-memory/definition";
import {
  convertSearchMemoryArgs,
  SSearchMemoryArgs,
  type TSearchMemoryArgs,
} from "./search-memory/handler";
import { UNSCHEDULE_CRON_JOB_TOOL } from "./unschedule-cron-job/definition";
import { SUnscheduleCronJobArgs } from "./unschedule-cron-job/handler";
import { UPDATE_CRON_JOB_TOOL } from "./update-cron-job/definition";
import {
  SUpdateCronJobArgs,
  type TUpdateCronJobArgs,
  validateUpdateCronJobArgs,
} from "./update-cron-job/handler";
import { UPDATE_SETTINGS_TOOL } from "./update-settings/definition";
import { SUpdateSettingsArgs, type TUpdateSettingsArgs } from "./update-settings/handler";
import { WEB_FETCH_TOOL } from "./web-fetch/definition";
import { SWebFetchArgs, validateWebFetchArgs } from "./web-fetch/handler";
import { WEB_SEARCH_TOOL } from "./web-search/definition";
import { SWebSearchArgs } from "./web-search/handler";

const SEQUENTIAL: "sequential" = "sequential";

export type TToolExecutionContext = {
  chatId: TOption<string>;
  settings: TConfigRecord;
  verifySettings: (settings: TConfigRecord, purposes: EModelPurpose[]) => Promise<TOption<string>>;
};

function textResult(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function requireChatId(chatId: TOption<string>): string {
  if (chatId === undefined) {
    throw new Error("This tool requires a chat owner");
  }

  return chatId;
}

export function createImportanceTool(): AgentTool<typeof SDefineMessageImportance> {
  return {
    name: DEFINE_MESSAGE_IMPORTANCE_TOOL,
    label: "Define message importance",
    description: "Assign an importance level to the supplied message",
    parameters: SDefineMessageImportance,
    execute: async (_toolCallId: string, args: unknown) =>
      textResult(Value.Decode(SDefineMessageImportance, args)),
  };
}

export function createMemoryTools(context: TToolExecutionContext) {
  return [
    {
      name: SEARCH_MEMORY_TOOL,
      label: "Search memory",
      description: "Search stored conversation memory",
      parameters: SSearchMemoryArgs,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs: TSearchMemoryArgs = Value.Decode(SSearchMemoryArgs, args);
        const convertedArgs = convertSearchMemoryArgs(parsedArgs);

        const result = await Memory.instance.find({
          chatId: requireChatId(context.chatId),
          ...convertedArgs,
        });

        if ("operation" in result) {
          throw new Error(`Memory ${result.operation} failed: ${String(result.error)}`);
        }

        result.sort(sortByImportanceAndDates);
        return textResult({ memories: result });
      },
    },
  ];
}

export function createSettingsTools(context: TToolExecutionContext) {
  return [
    {
      name: GET_SETTINGS_TOOL,
      label: "Get settings",
      description: "Read the owner's assistant settings",
      parameters: SGetSettingsArgs,
      execute: async () => {
        const settings = await SettingsService.instance.getAll(requireChatId(context.chatId));
        const provider = settings[EConfigKey.AiProvider];

        switch (provider) {
          case EAiProvider.OpenaiCodex:
          case EAiProvider.Openrouter:
          case EAiProvider.Ollama:
          case EAiProvider.OpencodeGo:
            return textResult({
              settings,
              aiRuntime: { provider, models: getAiModelIds(provider) },
            });
          default:
            throw new Error("Configured AI provider is invalid");
        }
      },
    },
    {
      name: UPDATE_SETTINGS_TOOL,
      label: "Update settings",
      description: "Update the owner's assistant settings",
      parameters: SUpdateSettingsArgs,
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs: TUpdateSettingsArgs = Value.Decode(SUpdateSettingsArgs, args);
        const updates: Array<{ field: keyof TUpdateSettingsArgs; key: EConfigKey; value: string }> =
          [];
        const fields: Array<{ field: keyof TUpdateSettingsArgs; key: EConfigKey }> = [
          { field: "timezone", key: EConfigKey.AiInstructionsTimezone },
          { field: "language", key: EConfigKey.AiInstructionsLanguage },
          { field: "assistantName", key: EConfigKey.AiInstructionsAssistantName },
          { field: "addressStyle", key: EConfigKey.AiInstructionsAddressStyle },
          { field: "preferredReplyLength", key: EConfigKey.AiInstructionsPreferredReplyLength },
          { field: "aiProvider", key: EConfigKey.AiProvider },
        ];

        for (const field of fields) {
          const value = parsedArgs[field.field];

          if (value !== undefined) {
            if (!ConfigValidators[field.key].safeParse(value).success) {
              throw new Error(`Invalid value for ${field.field}`);
            }

            updates.push({ ...field, value });
          }
        }

        if (updates.length === 0) {
          throw new Error("Provide at least one field to update");
        }

        const chatId = requireChatId(context.chatId);
        const settings = await SettingsService.instance.getAll(chatId);

        if (updates.some((update) => update.key === EConfigKey.AiProvider)) {
          const nextSettings = { ...settings };

          for (const update of updates) {
            nextSettings[update.key] = update.value;
          }

          const error = await context.verifySettings(nextSettings, [
            EModelPurpose.ToolCheap,
            EModelPurpose.ToolAccurate,
            EModelPurpose.ChatAccurate,
          ]);

          if (error !== undefined) {
            throw new Error(error);
          }
        }

        for (const update of updates) {
          await SettingsService.instance.set(chatId, update.key, update.value);
        }

        invalidateMessageHandlerInstructions(chatId);
        return textResult({ settings: await SettingsService.instance.getAll(chatId) });
      },
    },
  ];
}

export function createSchedulingTools(context: TToolExecutionContext) {
  const ownerTimezone = context.settings[EConfigKey.AiInstructionsTimezone];

  return [
    {
      name: LIST_CRON_JOBS_TOOL,
      label: "List cron jobs",
      description: "List the owner's scheduled jobs",
      parameters: SListCronJobsArgs,
      execute: async () =>
        textResult(await CronSingleton.instance.list(requireChatId(context.chatId))),
    },
    {
      name: SCHEDULE_ONCE_TOOL,
      label: "Schedule one-time job",
      description: "Schedule a one-time reminder or autonomous task",
      parameters: SScheduleOnceArgs,
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs: TScheduleOnceArgs = Value.Decode(SScheduleOnceArgs, args);
        const validatedArgs = validateScheduleOnceArgs(parsedArgs);
        const result = await CronSingleton.instance.createOnce({
          ...validatedArgs,
          scope: requireChatId(context.chatId),
          timezone: ownerTimezone,
        });

        if ("error" in result) {
          throw new Error(`${result.operation} failed: ${String(result.error)}`);
        }

        return textResult(result);
      },
    },
    {
      name: SCHEDULE_RECURRING_TOOL,
      label: "Schedule recurring job",
      description: "Schedule a recurring reminder or autonomous task",
      parameters: SScheduleRecurringArgs,
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs: TScheduleRecurringArgs = Value.Decode(SScheduleRecurringArgs, args);
        const validatedArgs = validateScheduleRecurringArgs(parsedArgs);
        const result = await CronSingleton.instance.createRecurring({
          ...validatedArgs,
          scope: requireChatId(context.chatId),
          timezone: ownerTimezone,
        });

        if ("error" in result) {
          throw new Error(`${result.operation} failed: ${String(result.error)}`);
        }

        return textResult(result);
      },
    },
    {
      name: UPDATE_CRON_JOB_TOOL,
      label: "Update cron job",
      description: "Update an existing scheduled job",
      parameters: SUpdateCronJobArgs,
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs: TUpdateCronJobArgs = Value.Decode(SUpdateCronJobArgs, args);
        const validatedArgs = validateUpdateCronJobArgs(parsedArgs);
        const chatId = requireChatId(context.chatId);
        const existing = await CronSingleton.instance.get(validatedArgs.name, chatId);

        if (existing === undefined) {
          throw new Error(`No job found with name: ${validatedArgs.name}`);
        }

        let reminderText = existing.reminderText;
        let reminderPromptData = existing.reminderPromptData;
        let reminderFallbackText = existing.reminderFallbackText;
        let taskPrompt = existing.taskPrompt;
        let taskFallbackText = existing.taskFallbackText;

        if (validatedArgs.reminderText !== undefined) {
          reminderText = validatedArgs.reminderText;
          reminderPromptData = undefined;
          reminderFallbackText =
            validatedArgs.reminderFallbackText ?? existing.reminderFallbackText;
          taskPrompt = undefined;
          taskFallbackText = undefined;
        } else if (validatedArgs.reminderPromptData !== undefined) {
          reminderText = undefined;
          reminderPromptData = validatedArgs.reminderPromptData;
          reminderFallbackText =
            validatedArgs.reminderFallbackText ?? existing.reminderFallbackText;
          taskPrompt = undefined;
          taskFallbackText = undefined;
        } else if (validatedArgs.taskPrompt !== undefined) {
          reminderText = undefined;
          reminderPromptData = undefined;
          reminderFallbackText = undefined;
          taskPrompt = validatedArgs.taskPrompt;
          taskFallbackText = validatedArgs.taskFallbackText ?? existing.taskFallbackText;
        }

        if (existing.type === ECronJobType.Recurring) {
          if (validatedArgs.fireAt !== undefined) {
            throw new Error(
              "fireAt can only update one-time reminders; use pattern for recurring reminders",
            );
          }

          const pattern = validatedArgs.pattern ?? existing.pattern;

          if (pattern === undefined) {
            throw new Error("Existing recurring reminder has no pattern");
          }

          const result = await CronSingleton.instance.createRecurring({
            name: existing.name,
            scope: chatId,
            group: validatedArgs.group ?? existing.group,
            pattern,
            reminderText,
            reminderPromptData,
            reminderFallbackText,
            taskPrompt,
            taskFallbackText,
            overwrite: true,
            timezone: existing.timezone,
          });

          if ("error" in result) {
            throw new Error(`${result.operation} failed: ${String(result.error)}`);
          }

          return textResult(result);
        }

        if (validatedArgs.pattern !== undefined) {
          throw new Error(
            "pattern can only update recurring reminders; use fireAt for one-time reminders",
          );
        }

        const result = await CronSingleton.instance.createOnce({
          name: existing.name,
          scope: chatId,
          group: validatedArgs.group ?? existing.group,
          fireAt: validatedArgs.fireAt ?? existing.nextRunAt,
          reminderText,
          reminderPromptData,
          reminderFallbackText,
          taskPrompt,
          taskFallbackText,
          overwrite: true,
          timezone: existing.timezone,
        });

        if ("error" in result) {
          throw new Error(`${result.operation} failed: ${String(result.error)}`);
        }

        return textResult(result);
      },
    },
    {
      name: UNSCHEDULE_CRON_JOB_TOOL,
      label: "Delete cron job",
      description: "Delete a scheduled job",
      parameters: SUnscheduleCronJobArgs,
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs = Value.Decode(SUnscheduleCronJobArgs, args);
        const result = await CronSingleton.instance.cancel(
          parsedArgs.name,
          requireChatId(context.chatId),
        );

        if ("error" in result) {
          throw new Error(`${result.operation} failed: ${String(result.error)}`);
        }

        return textResult(result);
      },
    },
  ];
}

export function createWebTools() {
  return [
    {
      name: WEB_SEARCH_TOOL,
      label: "Web search",
      description: "Search the public web for current information",
      parameters: SWebSearchArgs,
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs = Value.Decode(SWebSearchArgs, args);
        return textResult({
          query: parsedArgs.query,
          results: await searchWeb(parsedArgs, signal),
        });
      },
    },
    {
      name: WEB_FETCH_TOOL,
      label: "Web fetch",
      description: "Fetch a public HTTP or HTTPS URL",
      parameters: SWebFetchArgs,
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs = validateWebFetchArgs(Value.Decode(SWebFetchArgs, args));
        return textResult(await fetchWeb(parsedArgs, signal));
      },
    },
  ];
}
