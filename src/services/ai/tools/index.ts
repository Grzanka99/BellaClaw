import type { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "./define-message-importance/definition.ts";
import type { LIST_CRON_JOBS_TOOL } from "./list-cron-jobs/definition.ts";
import type { SCHEDULE_ONCE_TOOL } from "./schedule-once/definition.ts";
import type { SCHEDULE_RECURRING_TOOL } from "./schedule-recurring/definition.ts";
import type { SEARCH_MEMORY_TOOL } from "./search-memory/definition.ts";
import type { UNSCHEDULE_CRON_JOB_TOOL } from "./unschedule-cron-job/definition.ts";
import type { WEB_FETCH_TOOL } from "./web-fetch/definition.ts";
import type { WEB_SEARCH_TOOL } from "./web-search/definition.ts";

export type TTools =
  | typeof DEFINE_MESSAGE_IMPORTANCE_TOOL
  | typeof LIST_CRON_JOBS_TOOL
  | typeof SCHEDULE_ONCE_TOOL
  | typeof SCHEDULE_RECURRING_TOOL
  | typeof SEARCH_MEMORY_TOOL
  | typeof UNSCHEDULE_CRON_JOB_TOOL
  | typeof WEB_FETCH_TOOL
  | typeof WEB_SEARCH_TOOL;
