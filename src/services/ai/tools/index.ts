import type { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "./define-message-importance/definition.ts";
import type { LIST_CRON_JOBS_TOOL } from "./list-cron-jobs/definition.ts";
import type { SCHEDULE_RECURRING_TOOL } from "./schedule-recurring/definition.ts";
import type { SEARCH_MEMORY_TOOL } from "./search-memory/definition.ts";
import type { UNSCHEDULE_RECURRING_TOOL } from "./unschedule-recurring/definition.ts";

export type TTools =
  | typeof DEFINE_MESSAGE_IMPORTANCE_TOOL
  | typeof LIST_CRON_JOBS_TOOL
  | typeof SCHEDULE_RECURRING_TOOL
  | typeof SEARCH_MEMORY_TOOL
  | typeof UNSCHEDULE_RECURRING_TOOL;
