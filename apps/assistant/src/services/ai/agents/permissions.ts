import { EAgentName } from "../agent-harness";

export const AGENT_TOOL_NAMES: Record<EAgentName, readonly string[]> = {
  [EAgentName.Calendar]: [
    "list-calendars",
    "remove-readonly-calendar",
    "list-calendar-events",
    "find-calendar-availability",
    "create-calendar-event",
    "update-calendar-event",
    "delete-calendar-event",
    "web-search",
    "web-fetch",
  ],
  [EAgentName.Main]: [
    "web-search",
    "web-fetch",
    "delegate-calendar",
    "delegate-memory",
    "delegate-settings",
    "delegate-scheduling",
  ],
  [EAgentName.Memory]: ["search-memory", "remember-memory", "forget-memory"],
  [EAgentName.Settings]: ["get-settings", "update-settings"],
  [EAgentName.Scheduling]: [
    "list-cron-jobs",
    "schedule-once",
    "schedule-recurring",
    "update-cron-job",
    "unschedule-cron-job",
    "web-search",
    "web-fetch",
  ],
  [EAgentName.ScheduledTask]: [
    "search-memory",
    "web-search",
    "web-fetch",
    "list-calendar-events",
    "find-calendar-availability",
  ],
};
