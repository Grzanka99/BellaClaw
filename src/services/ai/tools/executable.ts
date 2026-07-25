import { Value } from "typebox/value";
import { ECronJobType } from "../../../lib/cron-engine";
import { fetchWeb, searchWeb } from "../../../lib/web";
import type { TOption } from "../../../types";
import { CalendarService } from "../../calendar";
import { CronSingleton } from "../../cron";
import { Memory } from "../../memory";
import { sortByImportanceAndDates } from "../../memory/sort";
import { SettingsService } from "../../settings";
import { ConfigValidators, EConfigKey, type TConfigRecord } from "../../settings/schema";
import { getAiModelIds } from "../providers/registry";
import { EAiProvider, EModelPurpose } from "../types";
import { addReadonlyCalendarTool } from "./add-readonly-calendar/definition";
import {
  SAddReadonlyCalendarArgs,
  type TAddReadonlyCalendarArgs,
} from "./add-readonly-calendar/handler";
import { createCalendarEventTool } from "./create-calendar-event/definition";
import {
  SCreateCalendarEventArgs,
  type TCreateCalendarEventArgs,
  validateCreateCalendarEventArgs,
} from "./create-calendar-event/handler";
import { deleteCalendarEventTool } from "./delete-calendar-event/definition";
import {
  SDeleteCalendarEventArgs,
  type TDeleteCalendarEventArgs,
} from "./delete-calendar-event/handler";
import { findCalendarAvailabilityTool } from "./find-calendar-availability/definition";
import {
  SFindCalendarAvailabilityArgs,
  type TFindCalendarAvailabilityArgs,
  validateFindCalendarAvailabilityArgs,
} from "./find-calendar-availability/handler";
import { getSettingsTool } from "./get-settings/definition";
import { listCalendarEventsTool } from "./list-calendar-events/definition";
import {
  SListCalendarEventsArgs,
  type TListCalendarEventsArgs,
  validateListCalendarEventsArgs,
} from "./list-calendar-events/handler";
import { listCalendarsTool } from "./list-calendars/definition";
import { SListCalendarsArgs } from "./list-calendars/handler";
import { listCronJobsTool } from "./list-cron-jobs/definition";
import { removeReadonlyCalendarTool } from "./remove-readonly-calendar/definition";
import {
  SRemoveReadonlyCalendarArgs,
  type TRemoveReadonlyCalendarArgs,
} from "./remove-readonly-calendar/handler";
import { scheduleOnceTool } from "./schedule-once/definition";
import {
  SScheduleOnceArgs,
  type TScheduleOnceArgs,
  validateScheduleOnceArgs,
} from "./schedule-once/handler";
import { scheduleRecurringTool } from "./schedule-recurring/definition";
import {
  SScheduleRecurringArgs,
  type TScheduleRecurringArgs,
  validateScheduleRecurringArgs,
} from "./schedule-recurring/handler";
import { searchMemoryTool } from "./search-memory/definition";
import {
  convertSearchMemoryArgs,
  SSearchMemoryArgs,
  type TSearchMemoryArgs,
} from "./search-memory/handler";
import { unscheduleCronJobTool } from "./unschedule-cron-job/definition";
import { SUnscheduleCronJobArgs } from "./unschedule-cron-job/handler";
import { updateCalendarEventTool } from "./update-calendar-event/definition";
import {
  SUpdateCalendarEventArgs,
  type TUpdateCalendarEventArgs,
  validateUpdateCalendarEventArgs,
} from "./update-calendar-event/handler";
import { updateCronJobTool } from "./update-cron-job/definition";
import {
  SUpdateCronJobArgs,
  type TUpdateCronJobArgs,
  validateUpdateCronJobArgs,
} from "./update-cron-job/handler";
import { updateSettingsTool } from "./update-settings/definition";
import { SUpdateSettingsArgs, type TUpdateSettingsArgs } from "./update-settings/handler";
import { webFetchTool } from "./web-fetch/definition";
import { SWebFetchArgs, validateWebFetchArgs } from "./web-fetch/handler";
import { webSearchTool } from "./web-search/definition";
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

export function createMemoryTools(context: TToolExecutionContext) {
  return [
    {
      ...searchMemoryTool,
      label: "Search memory",
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
      ...getSettingsTool,
      label: "Get settings",
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
      ...updateSettingsTool,
      label: "Update settings",
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
            EModelPurpose.Utility,
            EModelPurpose.Main,
            EModelPurpose.Specialist,
            EModelPurpose.SpecialistAccurate,
            EModelPurpose.ScheduledTask,
          ]);

          if (error !== undefined) {
            throw new Error(error);
          }
        }

        for (const update of updates) {
          await SettingsService.instance.set(chatId, update.key, update.value);
        }

        return textResult({ settings: await SettingsService.instance.getAll(chatId) });
      },
    },
  ];
}

export function createSchedulingTools(context: TToolExecutionContext) {
  const ownerTimezone = context.settings[EConfigKey.AiInstructionsTimezone];

  return [
    {
      ...listCronJobsTool,
      label: "List cron jobs",
      execute: async () =>
        textResult(await CronSingleton.instance.list(requireChatId(context.chatId))),
    },
    {
      ...scheduleOnceTool,
      label: "Schedule one-time job",
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
      ...scheduleRecurringTool,
      label: "Schedule recurring job",
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
      ...updateCronJobTool,
      label: "Update cron job",
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
      ...unscheduleCronJobTool,
      label: "Delete cron job",
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

export function createCalendarTools(context: TToolExecutionContext) {
  const ownerTimezone = context.settings[EConfigKey.AiInstructionsTimezone];

  return [
    {
      ...listCalendarsTool,
      label: "List calendars",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        Value.Decode(SListCalendarsArgs, args);
        return textResult(await CalendarService.instance.listCalendars(signal));
      },
    },
    {
      ...addReadonlyCalendarTool,
      label: "Add read-only calendar",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs: TAddReadonlyCalendarArgs = Value.Decode(SAddReadonlyCalendarArgs, args);
        return textResult(
          await CalendarService.instance.addReadonlyCalendar(parsedArgs.calendarId, signal),
        );
      },
    },
    {
      ...removeReadonlyCalendarTool,
      label: "Remove read-only calendar",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs: TRemoveReadonlyCalendarArgs = Value.Decode(
          SRemoveReadonlyCalendarArgs,
          args,
        );
        await CalendarService.instance.removeReadonlyCalendar(parsedArgs.calendarId);
        return textResult({ success: true });
      },
    },
    {
      ...listCalendarEventsTool,
      label: "List calendar events",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs: TListCalendarEventsArgs = Value.Decode(SListCalendarEventsArgs, args);
        const validatedArgs = validateListCalendarEventsArgs(parsedArgs);
        return textResult(await CalendarService.instance.listEvents({ ...validatedArgs, signal }));
      },
    },
    {
      ...findCalendarAvailabilityTool,
      label: "Find calendar availability",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs: TFindCalendarAvailabilityArgs = Value.Decode(
          SFindCalendarAvailabilityArgs,
          args,
        );
        const validatedArgs = validateFindCalendarAvailabilityArgs(parsedArgs);
        return textResult(
          await CalendarService.instance.findAvailability({
            ...validatedArgs,
            timezone: ownerTimezone,
            signal,
          }),
        );
      },
    },
    {
      ...createCalendarEventTool,
      label: "Create calendar event",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs: TCreateCalendarEventArgs = Value.Decode(SCreateCalendarEventArgs, args);
        const validatedArgs = validateCreateCalendarEventArgs(parsedArgs);
        return textResult(
          await CalendarService.instance.createEvent({
            ...validatedArgs,
            timezone: validatedArgs.timezone ?? ownerTimezone,
            signal,
          }),
        );
      },
    },
    {
      ...updateCalendarEventTool,
      label: "Update calendar event",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs: TUpdateCalendarEventArgs = Value.Decode(SUpdateCalendarEventArgs, args);
        const patch = validateUpdateCalendarEventArgs(parsedArgs);

        return textResult(
          await CalendarService.instance.updateEvent({
            eventId: parsedArgs.eventId,
            scope: parsedArgs.scope,
            patch,
            signal,
          }),
        );
      },
    },
    {
      ...deleteCalendarEventTool,
      label: "Delete calendar event",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs: TDeleteCalendarEventArgs = Value.Decode(SDeleteCalendarEventArgs, args);
        await CalendarService.instance.deleteEvent({ ...parsedArgs, signal });
        return textResult({ success: true });
      },
    },
  ];
}

export function createWebTools() {
  return [
    {
      ...webSearchTool,
      label: "Web search",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs = Value.Decode(SWebSearchArgs, args);
        return textResult({
          query: parsedArgs.query,
          results: await searchWeb(parsedArgs, signal),
        });
      },
    },
    {
      ...webFetchTool,
      label: "Web fetch",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs = validateWebFetchArgs(Value.Decode(SWebFetchArgs, args));
        return textResult(await fetchWeb(parsedArgs, signal));
      },
    },
  ];
}
