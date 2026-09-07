import type { TOption } from "@bellaclaw/shared";
import { fetchWeb, searchWeb } from "../../../lib/web";
import { CalendarService } from "../../calendar";
import { CronSingleton } from "../../cron";
import { MessageHandler } from "../../message-handler";
import { SettingsService } from "../../settings";
import { EConfigKey, type TConfigRecord } from "../../settings/schema";
import type { EModelPurpose } from "../types";
import { createCalendarEventTool } from "./create-calendar-event/definition";
import {
  SCreateCalendarEventArgs,
  validateCreateCalendarEventArgs,
} from "./create-calendar-event/handler";
import { validateToolArguments } from "./definition";
import { deleteCalendarEventTool } from "./delete-calendar-event/definition";
import { SDeleteCalendarEventArgs } from "./delete-calendar-event/handler";
import { findCalendarAvailabilityTool } from "./find-calendar-availability/definition";
import {
  SFindCalendarAvailabilityArgs,
  validateFindCalendarAvailabilityArgs,
} from "./find-calendar-availability/handler";
import { forgetMemoryTool, SForgetMemoryArgs } from "./forget-memory/definition";
import { handleForgetMemory } from "./forget-memory/handler";
import { getSettingsTool } from "./get-settings/definition";
import { createAiRuntime } from "./get-settings/handler";
import { listCalendarEventsTool } from "./list-calendar-events/definition";
import {
  SListCalendarEventsArgs,
  validateListCalendarEventsArgs,
} from "./list-calendar-events/handler";
import { listCalendarsTool } from "./list-calendars/definition";
import { SListCalendarsArgs } from "./list-calendars/handler";
import { listCronJobsTool } from "./list-cron-jobs/definition";
import { rememberMemoryTool, SRememberMemoryArgs } from "./remember-memory/definition";
import { handleRememberMemory } from "./remember-memory/handler";
import { removeReadonlyCalendarTool } from "./remove-readonly-calendar/definition";
import { SRemoveReadonlyCalendarArgs } from "./remove-readonly-calendar/handler";
import { scheduleOnceTool } from "./schedule-once/definition";
import { SScheduleOnceArgs, validateScheduleOnceArgs } from "./schedule-once/handler";
import { scheduleRecurringTool } from "./schedule-recurring/definition";
import {
  SScheduleRecurringArgs,
  validateScheduleRecurringArgs,
} from "./schedule-recurring/handler";
import { SSearchMemoryArgs, searchMemoryTool } from "./search-memory/definition";
import { handleSearchMemory } from "./search-memory/handler";
import { unscheduleCronJobTool } from "./unschedule-cron-job/definition";
import { SUnscheduleCronJobArgs } from "./unschedule-cron-job/handler";
import { updateCalendarEventTool } from "./update-calendar-event/definition";
import {
  SUpdateCalendarEventArgs,
  validateUpdateCalendarEventArgs,
} from "./update-calendar-event/handler";
import { updateCronJobTool } from "./update-cron-job/definition";
import { handleUpdateCronJob, SUpdateCronJobArgs } from "./update-cron-job/handler";
import { updateSettingsTool } from "./update-settings/definition";
import { handleUpdateSettings, SUpdateSettingsArgs } from "./update-settings/handler";
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
        const parsedArgs = validateToolArguments(SSearchMemoryArgs, args);
        const chatId = requireChatId(context.chatId);
        await MessageHandler.getInstance(chatId).ensureFactsCurrent();
        const result = await handleSearchMemory(chatId, parsedArgs);
        return textResult(result);
      },
    },
    {
      ...rememberMemoryTool,
      label: "Remember memory",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs = validateToolArguments(SRememberMemoryArgs, args);
        const result = await handleRememberMemory(requireChatId(context.chatId), parsedArgs);
        return textResult(result);
      },
    },
    {
      ...forgetMemoryTool,
      label: "Forget memory",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs = validateToolArguments(SForgetMemoryArgs, args);
        const result = await handleForgetMemory(requireChatId(context.chatId), parsedArgs);
        return textResult(result);
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

        return textResult({ settings, aiRuntime: createAiRuntime(settings, true) });
      },
    },
    {
      ...updateSettingsTool,
      label: "Update settings",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs = validateToolArguments(SUpdateSettingsArgs, args);
        return textResult(
          await handleUpdateSettings(
            requireChatId(context.chatId),
            parsedArgs,
            context.verifySettings,
          ),
        );
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
        const parsedArgs = validateToolArguments(SScheduleOnceArgs, args);
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
        const parsedArgs = validateToolArguments(SScheduleRecurringArgs, args);
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
        const parsedArgs = validateToolArguments(SUpdateCronJobArgs, args);
        return textResult(await handleUpdateCronJob(requireChatId(context.chatId), parsedArgs));
      },
    },
    {
      ...unscheduleCronJobTool,
      label: "Delete cron job",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs = validateToolArguments(SUnscheduleCronJobArgs, args);
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
  const userId = requireChatId(context.chatId);

  return [
    {
      ...listCalendarsTool,
      label: "List calendars",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        validateToolArguments(SListCalendarsArgs, args);
        return textResult(await CalendarService.instance.listCalendars(userId, signal));
      },
    },
    {
      ...removeReadonlyCalendarTool,
      label: "Remove read-only calendar",
      executionMode: SEQUENTIAL,
      execute: async (_toolCallId: string, args: unknown) => {
        const parsedArgs = validateToolArguments(SRemoveReadonlyCalendarArgs, args);
        await CalendarService.instance.removeReadonlyCalendar(userId, parsedArgs.calendarId);
        return textResult({ success: true });
      },
    },
    {
      ...listCalendarEventsTool,
      label: "List calendar events",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs = validateToolArguments(SListCalendarEventsArgs, args);
        const validatedArgs = validateListCalendarEventsArgs(parsedArgs);
        return textResult(
          await CalendarService.instance.listEvents({ ...validatedArgs, userId, signal }),
        );
      },
    },
    {
      ...findCalendarAvailabilityTool,
      label: "Find calendar availability",
      execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
        const parsedArgs = validateToolArguments(SFindCalendarAvailabilityArgs, args);
        const validatedArgs = validateFindCalendarAvailabilityArgs(parsedArgs);
        return textResult(
          await CalendarService.instance.findAvailability({
            ...validatedArgs,
            userId,
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
        const parsedArgs = validateToolArguments(SCreateCalendarEventArgs, args);
        const validatedArgs = validateCreateCalendarEventArgs(parsedArgs);
        return textResult(
          await CalendarService.instance.createEvent({
            ...validatedArgs,
            userId,
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
        const parsedArgs = validateToolArguments(SUpdateCalendarEventArgs, args);
        const patch = validateUpdateCalendarEventArgs(parsedArgs);

        return textResult(
          await CalendarService.instance.updateEvent({
            userId,
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
        const parsedArgs = validateToolArguments(SDeleteCalendarEventArgs, args);
        await CalendarService.instance.deleteEvent({ ...parsedArgs, userId, signal });
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
        const parsedArgs = validateToolArguments(SWebSearchArgs, args);
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
        const parsedArgs = validateWebFetchArgs(validateToolArguments(SWebFetchArgs, args));
        return textResult(await fetchWeb(parsedArgs, signal));
      },
    },
  ];
}
