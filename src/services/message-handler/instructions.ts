import { Config } from "../../config";
import { readXmlAndInjectConfig } from "../ai/instructions/read-xml-and-inject-config";

export type TMessageHandlerInstructions = {
  searchMemory: string;
  listCronJobs: string;
  scheduleOnce: string;
  scheduleRecurring: string;
  unscheduleCronJob: string;
  updateCronJob: string;
  webSearch: string;
  webFetch: string;
  defineMessageImportance: string;
};

async function loadMessageHandlerInstructions(): Promise<TMessageHandlerInstructions> {
  const [
    searchMemory,
    listCronJobs,
    scheduleOnce,
    scheduleRecurring,
    unscheduleCronJob,
    updateCronJob,
    webSearch,
    webFetch,
    defineMessageImportance,
  ] = await Promise.all([
    readXmlAndInjectConfig("./src/services/ai/tools/search-memory/instructions.xml", Config),
    readXmlAndInjectConfig("./src/services/ai/tools/list-cron-jobs/instructions.xml", Config),
    readXmlAndInjectConfig("./src/services/ai/tools/schedule-once/instructions.xml", Config),
    readXmlAndInjectConfig("./src/services/ai/tools/schedule-recurring/instructions.xml", Config),
    readXmlAndInjectConfig("./src/services/ai/tools/unschedule-cron-job/instructions.xml", Config),
    readXmlAndInjectConfig("./src/services/ai/tools/update-cron-job/instructions.xml", Config),
    readXmlAndInjectConfig("./src/services/ai/tools/web-search/instructions.xml", Config),
    readXmlAndInjectConfig("./src/services/ai/tools/web-fetch/instructions.xml", Config),
    readXmlAndInjectConfig(
      "./src/services/ai/tools/define-message-importance/instructions.xml",
      Config,
    ),
  ]);

  return {
    searchMemory,
    listCronJobs,
    scheduleOnce,
    scheduleRecurring,
    unscheduleCronJob,
    updateCronJob,
    webSearch,
    webFetch,
    defineMessageImportance,
  };
}

export const MessageHandlerInstructions = await loadMessageHandlerInstructions();
