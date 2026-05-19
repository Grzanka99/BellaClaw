import type { ToolDefinitionJson } from "@openrouter/sdk/models";
import { Config } from "../../../config";
import { createLogger } from "../../../utils/logger";
import { CronSingleton } from "../../cron";
import { readXmlAndInjectConfig } from "../instructions/read-xml-and-inject-config";
import { OpenrouterAiProvider } from "../providers/openrouter";
import {
  EAssistantLoopConversationItemKind,
  EAssistantLoopStopReason,
  runAssistantToolLoop,
  type TAssistantToolLoopResult,
  type TNormalizedToolResult,
  type TRuntimeConversationItem,
} from "../runtime";
import { LIST_CRON_JOBS_TOOL, listCronJobsTool } from "../tools/list-cron-jobs/definition";
import {
  SCHEDULE_RECURRING_TOOL,
  scheduleRecurringTool,
} from "../tools/schedule-recurring/definition";
import { EModelPurpose, ERole, type TPrompt, type TToolEntry } from "../types";

const logger = createLogger("AI MOCK");
const runId = Date.now();

type TMockUser = {
  username: string;
  id: string;
  displayName: string;
};

type TScenarioDefinition = {
  name: string;
  prompt: TPrompt;
  user: TMockUser;
  tools: TToolEntry[];
  expectedStopReason: EAssistantLoopStopReason;
  expectedToolNames: string[];
  maxIterations?: number;
  waitForFirstFire?: boolean;
};

const SCHEDULE_RECURRING_INSTRUCTIONS_PATH =
  "./src/services/ai/tools/schedule-recurring/instructions.xml";
const LIST_CRON_JOBS_INSTRUCTIONS_PATH = "./src/services/ai/tools/list-cron-jobs/instructions.xml";
const FIRE_TEST_TIMEOUT_MS = 10 * 60 * 1000;
const CRON_POLL_INTERVAL_MS = 1000;

function createPrompt(text: string): TPrompt {
  return {
    role: ERole.User,
    content: [{ type: "text", text }],
  };
}

function serialize(value: unknown): string {
  const json = JSON.stringify(
    value,
    (_key, currentValue) => {
      if (currentValue instanceof Date) {
        return currentValue.toISOString();
      }

      return currentValue;
    },
    2,
  );

  return json ?? "undefined";
}

function toolEntry(definition: ToolDefinitionJson, instructions: string): TToolEntry {
  return { definition, instructions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getToolResults(conversation: TRuntimeConversationItem[]): TNormalizedToolResult[] {
  const results: TNormalizedToolResult[] = [];

  for (const item of conversation) {
    if (item.kind !== EAssistantLoopConversationItemKind.ToolResult) {
      continue;
    }

    results.push(item.result);
  }

  return results;
}

function createUser(name: string): TMockUser {
  const id = `mock-runtime-${runId}-${name}`;

  return {
    username: "WannaCry_TM",
    id,
    displayName: "Misiaczek",
  };
}

async function createScenarios(): Promise<TScenarioDefinition[]> {
  const [scheduleRecurringInstructions, listCronJobsInstructions] = await Promise.all([
    readXmlAndInjectConfig(SCHEDULE_RECURRING_INSTRUCTIONS_PATH, Config),
    readXmlAndInjectConfig(LIST_CRON_JOBS_INSTRUCTIONS_PATH, Config),
  ]);

  const scheduleRecurringEntry = toolEntry(scheduleRecurringTool, scheduleRecurringInstructions);
  const listCronJobsEntry = toolEntry(listCronJobsTool, listCronJobsInstructions);
  const fireUser = createUser("fire-tool");
  const singleUser = createUser("single-tool");
  const multiUser = createUser("multi-tool");
  const listUser = createUser("list-tool");
  const weekdayUser = createUser("weekday-tool");
  const weekendUser = createUser("weekend-tool");

  return [
    {
      name: "OpenRouter schedules and waits for an actual reminder fire",
      prompt: createPrompt(
        "I'm checking if reminders actually fire. Every minute, remind me to look for the reminder event.",
      ),
      user: fireUser,
      tools: [scheduleRecurringEntry],
      expectedStopReason: EAssistantLoopStopReason.FinalResponse,
      expectedToolNames: [SCHEDULE_RECURRING_TOOL],
      waitForFirstFire: true,
    },
    {
      name: "OpenRouter schedules a casual recurring reminder",
      prompt: createPrompt("Yo, remind me every 30 minutes to drink water while I'm working."),
      user: singleUser,
      tools: [scheduleRecurringEntry],
      expectedStopReason: EAssistantLoopStopReason.FinalResponse,
      expectedToolNames: [SCHEDULE_RECURRING_TOOL],
    },
    {
      name: "OpenRouter schedules and lists cron jobs",
      prompt: createPrompt(
        "Every Monday at 9 in the morning remind me to review invoices. What reminders have I got now?",
      ),
      user: multiUser,
      tools: [scheduleRecurringEntry, listCronJobsEntry],
      expectedStopReason: EAssistantLoopStopReason.FinalResponse,
      expectedToolNames: [SCHEDULE_RECURRING_TOOL, LIST_CRON_JOBS_TOOL],
    },
    {
      name: "OpenRouter lists cron jobs",
      prompt: createPrompt("What reminders do I even have set up right now?"),
      user: listUser,
      tools: [listCronJobsEntry],
      expectedStopReason: EAssistantLoopStopReason.FinalResponse,
      expectedToolNames: [LIST_CRON_JOBS_TOOL],
    },
    {
      name: "OpenRouter schedules a weekday vitamins reminder",
      prompt: createPrompt(
        "I keep forgetting my vitamins. Every weekday at 7:30 in the morning remind me to take them.",
      ),
      user: weekdayUser,
      tools: [scheduleRecurringEntry],
      expectedStopReason: EAssistantLoopStopReason.FinalResponse,
      expectedToolNames: [SCHEDULE_RECURRING_TOOL],
    },
    {
      name: "OpenRouter schedules a weekend medicine reminder",
      prompt: createPrompt(
        "Every Tuesday and Saturday at 8 in the morning remind me to take that nail medicine thing.",
      ),
      user: weekendUser,
      tools: [scheduleRecurringEntry],
      expectedStopReason: EAssistantLoopStopReason.FinalResponse,
      expectedToolNames: [SCHEDULE_RECURRING_TOOL],
    },
  ];
}

function hasSuccessfulToolResult(toolResults: TNormalizedToolResult[], toolName: string): boolean {
  return toolResults.some((result) => result.toolName === toolName && result.success);
}

function validateScenario(scenario: TScenarioDefinition, result: TAssistantToolLoopResult) {
  if (result.stopReason !== scenario.expectedStopReason) {
    logger.warning(
      `Expected stop reason ${scenario.expectedStopReason} for ${scenario.name}, got ${result.stopReason}`,
    );
  }

  const toolResults = getToolResults(result.conversation);

  for (const toolName of scenario.expectedToolNames) {
    if (!hasSuccessfulToolResult(toolResults, toolName)) {
      logger.warning(`Expected successful ${toolName} tool call for ${scenario.name}`);
    }
  }
}

function getFirstScheduledJobName(result: TAssistantToolLoopResult): string | undefined {
  const toolResults = getToolResults(result.conversation);

  for (const toolResult of toolResults) {
    if (toolResult.toolName !== SCHEDULE_RECURRING_TOOL || !toolResult.success) {
      continue;
    }

    if (!isRecord(toolResult.data)) {
      continue;
    }

    if (typeof toolResult.data.name === "string") {
      return toolResult.data.name;
    }
  }

  return undefined;
}

async function waitForCronFire(jobName: string): Promise<boolean> {
  logger.message(`Waiting up to ${FIRE_TEST_TIMEOUT_MS / 1000}s for cron job to fire: ${jobName}`);

  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (success: boolean) => {
      if (resolved) {
        return;
      }

      resolved = true;
      clearTimeout(timer);
      CronSingleton.instance.off(jobName, onFire);
      resolve(success);
    };

    const onFire = (ctx: unknown) => {
      logger.message(["Cron reminder fired", "", serialize(ctx)].join("\n"));
      finish(true);
    };

    CronSingleton.instance.on(jobName, onFire);
    CronSingleton.instance.setup(CRON_POLL_INTERVAL_MS);
    timer = setTimeout(() => finish(false), FIRE_TEST_TIMEOUT_MS);
  });
}

async function waitForScenarioFire(
  scenario: TScenarioDefinition,
  result: TAssistantToolLoopResult,
) {
  if (scenario.waitForFirstFire !== true) {
    return;
  }

  const jobName = getFirstScheduledJobName(result);

  if (jobName === undefined) {
    logger.warning(`Cannot wait for fire in ${scenario.name}: no scheduled job name found`);
    return;
  }

  const fired = await waitForCronFire(jobName);

  if (!fired) {
    logger.warning(`Expected cron job ${jobName} to fire within ${FIRE_TEST_TIMEOUT_MS / 1000}s`);
  }
}

function logScenario(name: string, result: TAssistantToolLoopResult) {
  logger.message(
    [
      name,
      "",
      "Raw tool activity",
      serialize(result.toolActivity),
      "",
      "Final assistant reply",
      result.finalResponse ?? "<none>",
      "",
      `Stop reason: ${result.stopReason}`,
      `Iterations: ${result.iterations}`,
    ].join("\n"),
  );
}

async function cleanupCron(chatIds: string[]) {
  for (const chatId of chatIds) {
    const jobs = await CronSingleton.instance.getAllJobs(chatId);

    for (const job of jobs) {
      const result = await CronSingleton.instance.unschedule(job.name, chatId);

      if ("error" in result) {
        logger.warning(`Failed to unschedule cron job ${job.name}: ${String(result.error)}`);
      }
    }
  }

  CronSingleton.instance.destroy();
}

function assertOpenrouterConfigured() {
  const apiKey = Bun.env.OPENROUTER_API_KEY ?? "";

  if (apiKey.trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required to run src/services/ai/api/mock.ts");
  }
}

async function main() {
  assertOpenrouterConfigured();

  const scenarios = await createScenarios();
  const openrouter = OpenrouterAiProvider.instance;

  try {
    for (const scenario of scenarios) {
      const result = await runAssistantToolLoop({
        prompt: scenario.prompt,
        history: [],
        user: scenario.user,
        tools: scenario.tools,
        purpose: EModelPurpose.Chat,
        chatId: scenario.user.id,
        maxIterations: scenario.maxIterations,
        requestAssistantTurn: openrouter.requestAssistantTurn.bind(openrouter),
      });

      logScenario(scenario.name, result);
      validateScenario(scenario, result);
      await waitForScenarioFire(scenario, result);
    }
  } finally {
    await cleanupCron(scenarios.map((scenario) => scenario.user.id));
  }
}

await main();
