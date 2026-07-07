import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import {
  AiConnector,
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  defineMessageImportanceTool,
  EModelPurpose,
  ERole,
  searchMemoryTool,
  type THistoryItem,
  type TPrompt,
  webFetchTool,
  webSearchTool,
} from "../ai/api";
import { SDefineMessageImportance } from "../ai/tools/define-message-importance/handler";
import { listCronJobsTool } from "../ai/tools/list-cron-jobs/definition";
import { scheduleOnceTool } from "../ai/tools/schedule-once/definition";
import { scheduleRecurringTool } from "../ai/tools/schedule-recurring/definition";
import { unscheduleCronJobTool } from "../ai/tools/unschedule-cron-job/definition";
import { updateCronJobTool } from "../ai/tools/update-cron-job/definition";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../app-logger";
import { resolveAiBehaviorFields } from "../app-logger/ai";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import { SettingsService } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";
import { getMessageHandlerInstructions } from "./instructions";
import { getMessageTrace } from "./trace";
import type { TIncommingMessage, TOutgoingMessage } from "./types";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = AiConnector.instance;
  private queue = new AsyncQueue();
  private memory = Memory.instance;

  constructor(chatId: string) {
    this.logger = createLogger(`AbstractMessageHandler (cid: ${chatId})`);
    this.logger.info("created abstract message handler");
    this.logger.info("handler is up");
  }

  public static getInstance(chatId: string): MessageHandler {
    const instance = MessageHandler._instances.get(chatId);

    if (instance) {
      return instance;
    }

    const newInstance = new MessageHandler(chatId);
    MessageHandler._instances.set(chatId, newInstance);

    return newInstance;
  }

  public async handleMessage(message: TIncommingMessage): Promise<string> {
    const trace = getMessageTrace(message);
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");
    logHandlerStarted(trace, "message-handler");

    const settings = await SettingsService.instance.getAll(message.chatId);
    const instructions = await getMessageHandlerInstructions(message.chatId, settings);

    const parallelStart = performance.now();
    const [importance, last30] = await Promise.all([
      this.defineMessageImportance(
        message.message.content,
        message.chatId,
        settings,
        trace,
        ERole.User,
      ),
      this.retrieveMemory(message.chatId, trace),
    ]);
    this.logger.info(
      `handleMessage: parallel ops completed (${(performance.now() - parallelStart).toFixed(0)}ms) — importance: ${importance}, recent: ${last30.length}`,
    );

    this.queue.enqueue(() => this.saveMessageToDatabase(message, importance, trace));

    const history: THistoryItem[] = [];

    for (const el of last30.toReversed()) {
      history.push({
        role: el.author,
        content: el.message,
      });
    }

    history.push({
      role: ERole.System,
      content: createCurrentTimeContext(settings),
    });

    const tools = [
      { definition: searchMemoryTool, instructions: instructions.searchMemory },
      { definition: listCronJobsTool, instructions: instructions.listCronJobs },
      { definition: scheduleOnceTool, instructions: instructions.scheduleOnce },
      {
        definition: scheduleRecurringTool,
        instructions: instructions.scheduleRecurring,
      },
      {
        definition: unscheduleCronJobTool,
        instructions: instructions.unscheduleCronJob,
      },
      {
        definition: updateCronJobTool,
        instructions: instructions.updateCronJob,
      },
      { definition: webSearchTool, instructions: instructions.webSearch },
      { definition: webFetchTool, instructions: instructions.webFetch },
    ];

    const chatStart = performance.now();
    const aiRes = await this.ai.runAssistantToolLoop({
      prompt: {
        role: ERole.User,
        content: [{ type: "text", text: message.message.content }],
      },
      history,
      purpose: EModelPurpose.ChatAccurate,
      user: {
        username: message.author.username,
        id: message.author.id,
        displayName: message.author.username,
      },
      tools,
      chatId: message.chatId,
      settings,
      trace,
    });
    this.logger.info(
      `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
    );

    if (aiRes.finalResponse === undefined) {
      this.logger.warning("handleMessage: AI returned no final response");
      logHandlerCompleted(
        trace,
        "message-handler",
        handleMessageStart,
        false,
        "Something went wrong.".length,
        "missing final response",
        undefined,
      );
      return "Something went wrong.";
    }

    const finalResponse = aiRes.finalResponse;

    this.queue.enqueue(async () => {
      const respImpStart = performance.now();
      const responseImportance = await this.defineMessageImportance(
        finalResponse,
        message.chatId,
        settings,
        trace,
        ERole.Assistant,
      );
      this.logger.info(
        `handleMessage: response importance: ${responseImportance} (${(performance.now() - respImpStart).toFixed(0)}ms)`,
      );

      await this.saveMessageToDatabase(
        {
          chatId: message.chatId,
          message: {
            type: "text",
            content: finalResponse,
          },
          author: {
            type: ERole.Assistant,
          },
        },
        responseImportance,
        trace,
      );
    });

    this.logger.info(
      `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
    );
    logHandlerCompleted(
      trace,
      "message-handler",
      handleMessageStart,
      true,
      finalResponse.length,
      "completed",
      undefined,
    );
    return finalResponse;
  }

  private async defineMessageImportance(
    message: string,
    ownerKey: string,
    settings: TConfigRecord,
    trace: TOption<TBehaviorTraceContext>,
    author: ERole,
  ): Promise<EMemoryImportance> {
    const start = performance.now();

    const instructions = await getMessageHandlerInstructions(ownerKey, settings);

    const system: THistoryItem = {
      role: ERole.System,
      content: instructions.defineMessageImportance,
    };

    const uMessage: TPrompt = {
      role: ERole.User,
      content: [{ type: "text", text: message }],
    };

    const res = await this.ai.runToolTask({
      prompt: uMessage,
      history: [system],
      tools: [{ definition: defineMessageImportanceTool }],
      purpose: EModelPurpose.ToolCheap,
      chatId: undefined,
      user: undefined,
      settings,
      trace,
    });

    const realRes = res.toolResults.find(
      (toolResult) => toolResult.toolName === DEFINE_MESSAGE_IMPORTANCE_TOOL && toolResult.success,
    );

    if (realRes === undefined) {
      this.logger.error(
        `defineMessageImportance: failed, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logImportanceCompleted(trace, settings, start, false, author, EMemoryImportance.Low);
      return EMemoryImportance.Low;
    }

    const parsed = SDefineMessageImportance.safeParse(realRes.data);

    if (!parsed.success) {
      this.logger.error(
        `defineMessageImportance: invalid tool result, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logImportanceCompleted(trace, settings, start, false, author, EMemoryImportance.Low);
      return EMemoryImportance.Low;
    }

    this.logger.info(`defineMessageImportance: done (${(performance.now() - start).toFixed(0)}ms)`);
    logImportanceCompleted(trace, settings, start, true, author, parsed.data.importance);
    return parsed.data.importance;
  }

  private async saveMessageToDatabase(
    message: TIncommingMessage | TOutgoingMessage,
    importance: EMemoryImportance,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<boolean> {
    const start = performance.now();

    switch (message.author.type) {
      case ERole.User: {
        const result = await this.memory.save({
          chatId: message.chatId,
          author: ERole.User,
          importance,
          message: message.message.content,
        });
        logMemorySaveCompleted(
          trace,
          start,
          ERole.User,
          importance,
          message.message.content.length,
          result,
        );
        return true;
      }
      case ERole.Assistant: {
        const result = await this.memory.save({
          chatId: message.chatId,
          author: ERole.Assistant,
          importance,
          message: message.message.content,
        });
        logMemorySaveCompleted(
          trace,
          start,
          ERole.Assistant,
          importance,
          message.message.content.length,
          result,
        );
        return true;
      }
    }
  }

  // NOTE: Retrieve memory based on tool call response, always retrieve last 30 messages
  private async retrieveMemory(
    chatId: string,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<TMemory[]> {
    const start = performance.now();

    const res = await this.memory.findRecent(chatId, 30);

    if (!res.success) {
      this.logger.error(
        `retrieveMemory: failed to retrieve last 30 memories (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logMemoryRecentCompleted(trace, start, false, 0, 30, "Failed to retrieve recent memory");
      return [];
    }

    this.logger.info(`retrieveMemory: done (${(performance.now() - start).toFixed(0)}ms)`);
    logMemoryRecentCompleted(trace, start, true, res.data.length, 30, undefined);
    return res.data;
  }

  // NOTE: tbd, I think tool calls would require another handler to generate response message
  private async generateResponseMessageFromToolCall() {
    throw "Not implemented";
  }
}

function logHandlerStarted(trace: TOption<TBehaviorTraceContext>, handler: string) {
  if (trace === undefined) {
    return;
  }

  AppLogger.instance.record({
    trace,
    event: "handler.started",
    component: handler,
    summary: `${handler} started`,
    metadata: {
      handler,
    },
  });
}

function logHandlerCompleted(
  trace: TOption<TBehaviorTraceContext>,
  handler: string,
  start: number,
  success: boolean,
  replyChars: number,
  summary: string,
  error: TOption<string>,
) {
  if (trace === undefined) {
    return;
  }

  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "handler.completed",
    component: handler,
    level,
    success,
    durationMs: performance.now() - start,
    summary: `${handler} ${summary}`,
    metadata: {
      handler,
      replyChars,
    },
    error: sanitizeErrorMessage(error),
  });
}

function logImportanceCompleted(
  trace: TOption<TBehaviorTraceContext>,
  settings: TConfigRecord,
  start: number,
  success: boolean,
  author: ERole,
  importance: EMemoryImportance,
) {
  if (trace === undefined) {
    return;
  }

  const fields = resolveAiBehaviorFields(settings, EModelPurpose.ToolCheap);
  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "importance.completed",
    component: "message-handler",
    level,
    provider: fields?.provider,
    model: fields?.model,
    purpose: EModelPurpose.ToolCheap,
    success,
    durationMs: performance.now() - start,
    summary: `importance completed author=${author} importance=${importance}`,
    metadata: {
      author,
      importance,
    },
  });
}

function logMemoryRecentCompleted(
  trace: TOption<TBehaviorTraceContext>,
  start: number,
  success: boolean,
  count: number,
  limit: number,
  error: TOption<string>,
) {
  if (trace === undefined) {
    return;
  }

  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "memory.recent.completed",
    component: "memory",
    level,
    success,
    durationMs: performance.now() - start,
    summary: `recent memory completed count=${count} limit=${limit}`,
    metadata: {
      count,
      limit,
    },
    error: sanitizeErrorMessage(error),
  });
}

function logMemorySaveCompleted(
  trace: TOption<TBehaviorTraceContext>,
  start: number,
  author: ERole,
  importance: EMemoryImportance,
  messageChars: number,
  result: unknown,
) {
  if (trace === undefined) {
    return;
  }

  let success = true;
  let level = EBehaviorLogLevel.Info;
  let error: TOption<string>;

  if (isRecord(result) && "operation" in result) {
    success = false;
    level = EBehaviorLogLevel.Warning;
    error = String(result.error);
  }

  AppLogger.instance.record({
    trace,
    event: "memory.save.completed",
    component: "memory",
    level,
    success,
    durationMs: performance.now() - start,
    summary: `memory save completed author=${author} importance=${importance}`,
    metadata: {
      author,
      importance,
      messageChars,
    },
    error: sanitizeErrorMessage(error),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCurrentTimeContext(settings: TConfigRecord) {
  const now = new Date();
  const timezone = settings[EConfigKey.AiInstructionsTimezone];

  return [
    "Current time context:",
    `UTC: ${now.toISOString()}`,
    `Timezone: ${timezone}`,
    `Local: ${now.toLocaleString("sv-SE-u-nu-latn", {
      timeZone: timezone,
      hourCycle: "h23",
    })}`,
    `Weekday: ${now.toLocaleString("en-US-u-nu-latn", {
      timeZone: timezone,
      weekday: "long",
    })}`,
  ].join("\n");
}
