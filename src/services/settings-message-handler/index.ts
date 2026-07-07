import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { AiConnector, EModelPurpose, ERole, type THistoryItem } from "../ai/api";
import { getSettingsTool } from "../ai/tools/get-settings/definition";
import { updateSettingsTool } from "../ai/tools/update-settings/definition";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../app-logger";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import { getMessageTrace } from "../message-handler/trace";
import type { TIncommingMessage } from "../message-handler/types";
import { SettingsService } from "../settings";
import { createStableAiRuntimeSettings } from "../settings/schema";
import { getSettingsHandlerInstructions } from "./instructions";

const RECENT_MEMORY_LIMIT = 30;

export class SettingsMessageHandler {
  private static _instances = new Map<string, SettingsMessageHandler>();
  private logger: TLogger;
  private ai = AiConnector.instance;
  private memory = Memory.instance;

  constructor(chatId: string) {
    this.logger = createLogger(`SettingsMessageHandler (cid: ${chatId})`);
    this.logger.info("created settings message handler");
  }

  public static getInstance(chatId: string): SettingsMessageHandler {
    const instance = SettingsMessageHandler._instances.get(chatId);

    if (instance) {
      return instance;
    }

    const newInstance = new SettingsMessageHandler(chatId);
    SettingsMessageHandler._instances.set(chatId, newInstance);

    return newInstance;
  }

  public async handleMessage(message: TIncommingMessage): Promise<string> {
    const trace = getMessageTrace(message);
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");
    logHandlerStarted(trace);

    const settings = await SettingsService.instance.getAll(message.chatId);
    const runtimeSettings = createStableAiRuntimeSettings(settings);
    const instructions = await getSettingsHandlerInstructions(settings);

    const recent = await this.retrieveMemory(message.chatId, trace);

    const history: THistoryItem[] = [{ role: ERole.System, content: instructions.systemPrompt }];

    for (const el of recent.toReversed()) {
      history.push({
        role: el.author,
        content: el.message,
      });
    }

    const userSaveStart = performance.now();
    const userSaveResult = await this.memory.save({
      chatId: message.chatId,
      author: ERole.User,
      importance: EMemoryImportance.Low,
      message: message.message.content,
    });
    logMemorySaveCompleted(
      trace,
      userSaveStart,
      ERole.User,
      EMemoryImportance.Low,
      message.message.content.length,
      userSaveResult,
    );

    const tools = [
      { definition: getSettingsTool, instructions: instructions.getSettings },
      { definition: updateSettingsTool, instructions: instructions.updateSettings },
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
      settings: runtimeSettings,
      trace,
    });
    this.logger.info(
      `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
    );

    if (aiRes.finalResponse === undefined) {
      this.logger.warning("handleMessage: AI returned no final response");
      logHandlerCompleted(
        trace,
        handleMessageStart,
        false,
        "Something went wrong.".length,
        "missing final response",
        undefined,
      );
      return "Something went wrong.";
    }

    const assistantSaveStart = performance.now();
    const assistantSaveResult = await this.memory.save({
      chatId: message.chatId,
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: aiRes.finalResponse,
    });
    logMemorySaveCompleted(
      trace,
      assistantSaveStart,
      ERole.Assistant,
      EMemoryImportance.Low,
      aiRes.finalResponse.length,
      assistantSaveResult,
    );

    this.logger.info(
      `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
    );
    logHandlerCompleted(
      trace,
      handleMessageStart,
      true,
      aiRes.finalResponse.length,
      "completed",
      undefined,
    );
    return aiRes.finalResponse;
  }

  private async retrieveMemory(
    chatId: string,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<TMemory[]> {
    const start = performance.now();

    const res = await this.memory.findRecent(chatId, RECENT_MEMORY_LIMIT);

    if (!res.success) {
      this.logger.error(
        `retrieveMemory: failed to retrieve last ${RECENT_MEMORY_LIMIT} memories (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logMemoryRecentCompleted(
        trace,
        start,
        false,
        0,
        RECENT_MEMORY_LIMIT,
        "Failed to retrieve recent memory",
      );
      return [];
    }

    this.logger.info(`retrieveMemory: done (${(performance.now() - start).toFixed(0)}ms)`);
    logMemoryRecentCompleted(trace, start, true, res.data.length, RECENT_MEMORY_LIMIT, undefined);
    return res.data;
  }
}

function logHandlerStarted(trace: TOption<TBehaviorTraceContext>) {
  if (trace === undefined) {
    return;
  }

  AppLogger.instance.record({
    trace,
    event: "handler.started",
    component: "settings-message-handler",
    summary: "settings-message-handler started",
    metadata: {
      handler: "settings-message-handler",
    },
  });
}

function logHandlerCompleted(
  trace: TOption<TBehaviorTraceContext>,
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
    component: "settings-message-handler",
    level,
    success,
    durationMs: performance.now() - start,
    summary: `settings-message-handler ${summary}`,
    metadata: {
      handler: "settings-message-handler",
      replyChars,
    },
    error: sanitizeErrorMessage(error),
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
