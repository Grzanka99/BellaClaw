import { readXmlAndInjectConfig } from "../ai/instructions/read-xml-and-inject-config";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

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

const instructionsCache = new Map<string, TMessageHandlerInstructions>();

const INSTRUCTION_SOURCES = {
  searchMemory: "./src/services/ai/tools/search-memory/instructions.xml",
  listCronJobs: "./src/services/ai/tools/list-cron-jobs/instructions.xml",
  scheduleOnce: "./src/services/ai/tools/schedule-once/instructions.xml",
  scheduleRecurring: "./src/services/ai/tools/schedule-recurring/instructions.xml",
  unscheduleCronJob: "./src/services/ai/tools/unschedule-cron-job/instructions.xml",
  updateCronJob: "./src/services/ai/tools/update-cron-job/instructions.xml",
  webSearch: "./src/services/ai/tools/web-search/instructions.xml",
  webFetch: "./src/services/ai/tools/web-fetch/instructions.xml",
  defineMessageImportance: "./src/services/ai/tools/define-message-importance/instructions.xml",
} as const;

async function loadMessageHandlerInstructions(
  settings: TConfigRecord,
): Promise<TMessageHandlerInstructions> {
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
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.searchMemory, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.listCronJobs, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.scheduleOnce, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.scheduleRecurring, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.unscheduleCronJob, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.updateCronJob, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.webSearch, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.webFetch, settings),
    readXmlAndInjectConfig(INSTRUCTION_SOURCES.defineMessageImportance, settings),
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

function buildSettingsSignature(settings: TConfigRecord): string {
  const keys = Object.values(EConfigKey).sort();
  const entries = keys.map((key) => [key, settings[key]]);
  return JSON.stringify(entries);
}

export async function getMessageHandlerInstructions(
  ownerKey: string,
  settings: TConfigRecord,
): Promise<TMessageHandlerInstructions> {
  const cacheKey = `${ownerKey}\n${buildSettingsSignature(settings)}`;
  const cached = instructionsCache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const loaded = await loadMessageHandlerInstructions(settings);
  instructionsCache.set(cacheKey, loaded);
  return loaded;
}

export function invalidateMessageHandlerInstructions(ownerKey?: string): void {
  if (ownerKey === undefined) {
    instructionsCache.clear();
    return;
  }

  const prefix = `${ownerKey}\n`;

  for (const key of instructionsCache.keys()) {
    if (key.startsWith(prefix)) {
      instructionsCache.delete(key);
    }
  }
}
