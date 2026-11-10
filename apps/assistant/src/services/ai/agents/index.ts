import type { TOption } from "@bellaclaw/shared";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { createCalendarEvent } from "../tools/create-calendar-event";
import type { TTool } from "../tools/define-tool";
import { deleteCalendarEvent } from "../tools/delete-calendar-event";
import { findCalendarAvailability } from "../tools/find-calendar-availability";
import { forgetMemory } from "../tools/forget-memory";
import { getSettings } from "../tools/get-settings";
import { listCalendarEvents } from "../tools/list-calendar-events";
import { listCalendars } from "../tools/list-calendars";
import { listCronJobs } from "../tools/list-cron-jobs";
import { rememberMemory } from "../tools/remember-memory";
import { removeReadonlyCalendar } from "../tools/remove-readonly-calendar";
import { scheduleOnce } from "../tools/schedule-once";
import { scheduleRecurring } from "../tools/schedule-recurring";
import { searchMemory } from "../tools/search-memory";
import { unscheduleCronJob } from "../tools/unschedule-cron-job";
import { updateCalendarEvent } from "../tools/update-calendar-event";
import { updateCronJob } from "../tools/update-cron-job";
import { updateSettings } from "../tools/update-settings";
import { webFetch } from "../tools/web-fetch";
import { webSearch } from "../tools/web-search";
import { EModelPurpose } from "../types";
import calendarInstructions from "./calendar.xml" with { type: "text" };
import mainInstructions from "./main.xml" with { type: "text" };
import mcpInstructions from "./mcp.xml" with { type: "text" };
import memoryInstructions from "./memory.xml" with { type: "text" };
import scheduledTaskInstructions from "./scheduled-task.xml" with { type: "text" };
import schedulingInstructions from "./scheduling.xml" with { type: "text" };
import settingsInstructions from "./settings.xml" with { type: "text" };

export enum EAgentName {
  Calendar = "calendar",
  Main = "main",
  Mcp = "mcp",
  Memory = "memory",
  Settings = "settings",
  Scheduling = "scheduling",
  ScheduledTask = "scheduled-task",
}

type TAgentDefinition = {
  purpose: EModelPurpose;
  maxIterations: number;
  instructions: string;
  tools: TTool[];
  delegates: EAgentName[];
  // NOTE: the `delegate-mcp`, `resume-mcp` and `cancel-mcp` tools.
  mcp: boolean;
  // How a delegating agent sees this agent; undefined when nothing delegates to it.
  delegation: TOption<{ description: string; mode: ToolExecutionMode }>;
};

const WEB_TOOLS = [webSearch, webFetch];

export const AGENTS: Record<EAgentName, TAgentDefinition> = {
  [EAgentName.Calendar]: {
    purpose: EModelPurpose.SpecialistAccurate,
    maxIterations: 12,
    instructions: calendarInstructions,
    tools: [
      listCalendars,
      removeReadonlyCalendar,
      listCalendarEvents,
      findCalendarAvailability,
      createCalendarEvent,
      updateCalendarEvent,
      deleteCalendarEvent,
      ...WEB_TOOLS,
    ],
    delegates: [],
    mcp: false,
    delegation: {
      description: "Run the calendar specialist for this focused task",
      mode: "sequential",
    },
  },
  [EAgentName.Main]: {
    purpose: EModelPurpose.Main,
    maxIterations: 30,
    instructions: mainInstructions,
    tools: WEB_TOOLS,
    delegates: [EAgentName.Calendar, EAgentName.Memory, EAgentName.Settings, EAgentName.Scheduling],
    mcp: true,
    delegation: undefined,
  },
  [EAgentName.Mcp]: {
    purpose: EModelPurpose.SpecialistAccurate,
    maxIterations: 12,
    instructions: mcpInstructions,
    tools: [],
    delegates: [],
    mcp: false,
    delegation: undefined,
  },
  [EAgentName.Memory]: {
    purpose: EModelPurpose.Specialist,
    maxIterations: 12,
    instructions: memoryInstructions,
    tools: [searchMemory, rememberMemory, forgetMemory],
    delegates: [],
    mcp: false,
    delegation: {
      description:
        "Required for personal user facts and forget requests. Run the Memory specialist to retrieve or forget the relevant facts.",
      mode: "parallel",
    },
  },
  [EAgentName.Settings]: {
    purpose: EModelPurpose.Specialist,
    maxIterations: 12,
    instructions: settingsInstructions,
    tools: [getSettings, updateSettings],
    delegates: [],
    mcp: false,
    delegation: {
      description: "Run the settings specialist for this focused task",
      mode: "parallel",
    },
  },
  [EAgentName.Scheduling]: {
    purpose: EModelPurpose.SpecialistAccurate,
    maxIterations: 12,
    instructions: schedulingInstructions,
    tools: [
      listCronJobs,
      scheduleOnce,
      scheduleRecurring,
      updateCronJob,
      unscheduleCronJob,
      ...WEB_TOOLS,
    ],
    delegates: [],
    mcp: false,
    delegation: {
      description: "Run the scheduling specialist for this focused task",
      mode: "sequential",
    },
  },
  [EAgentName.ScheduledTask]: {
    purpose: EModelPurpose.ScheduledTask,
    maxIterations: 30,
    instructions: scheduledTaskInstructions,
    tools: [searchMemory, ...WEB_TOOLS, listCalendarEvents, findCalendarAvailability, listCronJobs],
    delegates: [],
    mcp: true,
    delegation: undefined,
  },
};
