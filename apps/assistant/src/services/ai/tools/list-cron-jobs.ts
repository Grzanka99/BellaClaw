import { obj } from "@earendil-works/pi-schema";
import { CronSingleton } from "../../cron";
import { defineTool, requireChatId } from "./define-tool";
import instructions from "./list-cron-jobs.xml" with { type: "text" };

export const listCronJobs = defineTool({
  name: "list-cron-jobs",
  label: "List cron jobs",
  description:
    "List all currently scheduled cron jobs. Use this to check what reminders or recurring tasks exist, so you can inform the user or decide whether to unschedule any.",
  schema: obj({}, { description: "No arguments are required" }),
  instructions,
  mode: "parallel",
  logSafe: [],
  privateErrors: true,
  execute: async (context) => {
    return CronSingleton.instance.list(requireChatId(context.chatId));
  },
});
