import type { ChatMessageToolCall, ToolDefinitionJson } from "@openrouter/sdk/models";
import { createLogger } from "../../../utils/logger";
import { CronSingleton } from "../../cron";
import {
  EAssistantLoopConversationItemKind,
  EAssistantLoopStopReason,
  type TAssistantToolLoopResult,
  type TNormalizedToolResult,
  type TRequestAssistantTurn,
  type TRuntimeConversationItem,
} from "../runtime";
import { LIST_CRON_JOBS_TOOL, listCronJobsTool } from "../tools/list-cron-jobs/definition";
import {
  SCHEDULE_RECURRING_TOOL,
  scheduleRecurringTool,
} from "../tools/schedule-recurring/definition";
import { unscheduleRecurringTool } from "../tools/unschedule-recurring/definition";
import { EModelPurpose, ERole, type TPrompt, type TToolEntry } from "../types";
import { AiConnector } from "./index";

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
  requestAssistantTurn: TRequestAssistantTurn;
  maxIterations?: number;
};

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

function toolEntry(definition: ToolDefinitionJson): TToolEntry {
  return { definition };
}

function createToolCall(id: string, name: string, argumentsText: string): ChatMessageToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCronJobSummary(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === "string";
}

function isCronJobSummaryArray(value: unknown): value is Array<{ name: string }> {
  return Array.isArray(value) && value.every((item) => isCronJobSummary(item));
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

function getLatestToolResult(
  conversation: TRuntimeConversationItem[],
  toolName: string,
): TNormalizedToolResult | undefined {
  const results = getToolResults(conversation);

  for (let index = results.length - 1; index >= 0; index--) {
    const result = results[index];

    if (result?.toolName === toolName) {
      return result;
    }
  }

  return undefined;
}

function createUser(name: string): TMockUser {
  const id = `mock-runtime-${runId}-${name}`;

  return {
    username: "WannaCry_TM",
    id,
    displayName: "Misiaczek",
  };
}

function createSingleToolRequester(reminderName: string): TRequestAssistantTurn {
  let turn = 0;

  return async ({ conversation }) => {
    if (turn === 0) {
      turn += 1;

      return {
        response: "",
        toolCalls: [
          createToolCall(
            "single-schedule",
            SCHEDULE_RECURRING_TOOL,
            JSON.stringify({
              name: reminderName,
              pattern: "*/30 * * * *",
              group: "mock-single",
            }),
          ),
        ],
      };
    }

    const scheduleResult = getLatestToolResult(conversation, SCHEDULE_RECURRING_TOOL);

    if (scheduleResult?.success && isCronJobSummary(scheduleResult.data)) {
      return {
        response: `Scheduled reminder ${scheduleResult.data.name} every 30 minutes.`,
        toolCalls: [],
      };
    }

    return {
      response: `I could not schedule reminder ${reminderName}.`,
      toolCalls: [],
    };
  };
}

function createMultipleToolRequester(reminderName: string): TRequestAssistantTurn {
  let turn = 0;

  return async ({ conversation }) => {
    if (turn === 0) {
      turn += 1;

      return {
        response: "",
        toolCalls: [
          createToolCall(
            "multi-schedule",
            SCHEDULE_RECURRING_TOOL,
            JSON.stringify({
              name: reminderName,
              pattern: "0 9 * * 1",
              group: "mock-batch",
            }),
          ),
          createToolCall("multi-list", LIST_CRON_JOBS_TOOL, "{}"),
        ],
      };
    }

    const scheduleResult = getLatestToolResult(conversation, SCHEDULE_RECURRING_TOOL);
    const listResult = getLatestToolResult(conversation, LIST_CRON_JOBS_TOOL);

    if (
      scheduleResult?.success &&
      isCronJobSummary(scheduleResult.data) &&
      listResult?.success &&
      isCronJobSummaryArray(listResult.data)
    ) {
      return {
        response: `Scheduled ${scheduleResult.data.name}. You now have ${listResult.data.length} cron job(s).`,
        toolCalls: [],
      };
    }

    return {
      response: `I could not complete the schedule-and-list flow for ${reminderName}.`,
      toolCalls: [],
    };
  };
}

function createInvalidArgsRequester(): TRequestAssistantTurn {
  let turn = 0;

  return async ({ conversation }) => {
    if (turn === 0) {
      turn += 1;

      return {
        response: "",
        toolCalls: [
          createToolCall(
            "bad-schedule",
            SCHEDULE_RECURRING_TOOL,
            '{"name":"broken-reminder","pattern":',
          ),
        ],
      };
    }

    const scheduleResult = getLatestToolResult(conversation, SCHEDULE_RECURRING_TOOL);

    return {
      response: `Scheduling failed with: ${scheduleResult?.error ?? "unknown error"}`,
      toolCalls: [],
    };
  };
}

function createMaxIterationRequester(): TRequestAssistantTurn {
  return async () => {
    return {
      response: "",
      toolCalls: [createToolCall("max-list", LIST_CRON_JOBS_TOOL, "{}")],
    };
  };
}

function createRepeatedToolRequester(): TRequestAssistantTurn {
  return async () => {
    return {
      response: "",
      toolCalls: [createToolCall("repeat-list", LIST_CRON_JOBS_TOOL, "{}")],
    };
  };
}

function createScenarios(): TScenarioDefinition[] {
  const singleUser = createUser("single-tool");
  const multiUser = createUser("multi-tool");
  const invalidArgsUser = createUser("invalid-args");
  const maxIterationUser = createUser("max-iteration");
  const repeatedUser = createUser("repeated-tool-call");

  return [
    {
      name: "One tool call followed by final assistant reply",
      prompt: createPrompt("Please schedule a recurring reminder every 30 minutes."),
      user: singleUser,
      tools: [toolEntry(scheduleRecurringTool)],
      requestAssistantTurn: createSingleToolRequester(`single-reminder-${runId}`),
    },
    {
      name: "Multiple tool calls in one request",
      prompt: createPrompt("Schedule a Monday reminder and then show me my cron jobs."),
      user: multiUser,
      tools: [toolEntry(scheduleRecurringTool), toolEntry(listCronJobsTool)],
      requestAssistantTurn: createMultipleToolRequester(`multi-reminder-${runId}`),
    },
    {
      name: "Cron failure path with invalid tool arguments",
      prompt: createPrompt("Schedule a reminder, but the model sends broken arguments."),
      user: invalidArgsUser,
      tools: [toolEntry(scheduleRecurringTool)],
      requestAssistantTurn: createInvalidArgsRequester(),
    },
    {
      name: "Loop termination by max-iteration guard",
      prompt: createPrompt("Keep asking for the cron list forever."),
      user: maxIterationUser,
      tools: [toolEntry(listCronJobsTool)],
      requestAssistantTurn: createMaxIterationRequester(),
      maxIterations: 1,
    },
    {
      name: "Loop termination by repeated tool-call guard",
      prompt: createPrompt("Repeat the same cron tool call without making progress."),
      user: repeatedUser,
      tools: [toolEntry(listCronJobsTool), toolEntry(unscheduleRecurringTool)],
      requestAssistantTurn: createRepeatedToolRequester(),
      maxIterations: 3,
    },
  ];
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

async function main() {
  const scenarios = createScenarios();

  try {
    for (const scenario of scenarios) {
      const result = await AiConnector.instance.runAssistantToolLoop({
        prompt: scenario.prompt,
        history: [],
        user: scenario.user,
        tools: scenario.tools,
        purpose: EModelPurpose.Chat,
        chatId: scenario.user.id,
        maxIterations: scenario.maxIterations,
        requestAssistantTurn: scenario.requestAssistantTurn,
      });

      logScenario(scenario.name, result);

      const toolResults = getToolResults(result.conversation);

      if (
        scenario.name === "Loop termination by repeated tool-call guard" &&
        result.stopReason !== EAssistantLoopStopReason.RepeatedToolCall
      ) {
        logger.warning(`Expected repeated tool-call guard, got ${result.stopReason}`);
      }

      if (
        scenario.name === "Loop termination by max-iteration guard" &&
        result.stopReason !== EAssistantLoopStopReason.MaxIterations
      ) {
        logger.warning(`Expected max-iterations guard, got ${result.stopReason}`);
      }

      if (
        toolResults.length === 0 &&
        result.stopReason === EAssistantLoopStopReason.FinalResponse
      ) {
        logger.warning("Scenario finished without any tool results");
      }
    }
  } finally {
    await cleanupCron(scenarios.map((scenario) => scenario.user.id));
  }
}

await main();
