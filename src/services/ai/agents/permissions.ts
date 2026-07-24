import { EAgentName } from "../agent-harness";

export const AGENT_TOOL_NAMES: Record<EAgentName, readonly string[]> = {
  [EAgentName.Main]: [
    "web-search",
    "web-fetch",
    "delegate-memory",
    "delegate-settings",
    "delegate-scheduling",
  ],
  [EAgentName.Memory]: ["search-memory"],
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
  [EAgentName.ScheduledTask]: ["search-memory", "web-search", "web-fetch"],
};
