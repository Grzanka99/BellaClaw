import { AppLogger, createCronTurnId, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import type { TCronJobContext } from "../../lib/cron-engine";
import { AgentHarness } from "../ai/agent-harness";
import { LlmClient } from "../ai/llm";
import { ERole } from "../ai/types";
import {
  logHandlerCompleted,
  logHandlerStarted,
  logMemorySaveCompleted,
} from "../app-logger/operations";
import { CronSingleton } from "../cron";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { parseCanonicalChatKey } from "../messaging/chat-key";
import { formatCommandList } from "../messaging/commands";
import type { EMessagePlatform, TMessageTransport } from "../messaging/types";
import {
  generateReminderText,
  generateScheduledTaskText,
  type TScheduledTaskResult,
} from "./generate-reminder-text";

export class ScheduledDelivery {
  private static _instance: TOption<ScheduledDelivery>;
  private logger: TLogger = createLogger("SCHEDULING");
  private messaging = MessagingAdapter.instance;
  private ai = AgentHarness.instance;
  private llm = LlmClient.instance;
  private runningCronTaskKeys = new Set<string>();

  private constructor() {}

  public static get instance() {
    if (!ScheduledDelivery._instance) {
      ScheduledDelivery._instance = new ScheduledDelivery();
    }

    return ScheduledDelivery._instance;
  }

  public async setup() {
    CronSingleton.instance.onFire(this.handleCronFire.bind(this));
    await CronSingleton.instance.setup();
  }

  private async handleCronFire(ctx: TCronJobContext) {
    const trace: TBehaviorTraceContext = {
      turnId: createCronTurnId(),
      chatId: ctx.scope,
      platform: undefined,
    };
    const handlerStart = performance.now();
    logHandlerStarted(trace, "cron-fire");

    const canonicalChatId = ctx.scope;
    if (canonicalChatId === undefined) {
      this.logger.warning(`handleCronFire: job "${ctx.name}" has no scope, skipping delivery`);
      logHandlerCompleted(trace, "cron-fire", handlerStart, false, 0, "missing scope", undefined);
      return;
    }

    const parsedScope = parseCanonicalChatKey(canonicalChatId);
    if (parsedScope === undefined) {
      this.logger.warning(
        `handleCronFire: job "${ctx.name}" has invalid scope "${canonicalChatId}", skipping delivery`,
      );
      logHandlerCompleted(trace, "cron-fire", handlerStart, false, 0, "invalid scope", undefined);
      return;
    }

    trace.platform = parsedScope.platform;

    const transport = await this.messaging.waitForTransport(parsedScope.platform);
    if (transport === undefined) {
      this.logger.warning(
        `handleCronFire: no ${parsedScope.platform} transport for reminder "${ctx.name}", skipping delivery`,
      );
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        0,
        "missing transport",
        undefined,
      );
      return;
    }

    if (ctx.taskPrompt !== undefined) {
      const taskKey = JSON.stringify([canonicalChatId, ctx.name]);

      if (this.runningCronTaskKeys.has(taskKey)) {
        this.logger.warning(`handleCronFire: task "${ctx.name}" is already running, skipping`);
        logHandlerCompleted(
          trace,
          "cron-fire",
          handlerStart,
          true,
          0,
          "task overlap skipped",
          undefined,
        );
        return;
      }

      this.runningCronTaskKeys.add(taskKey);

      try {
        await this.handleCronDelivery(
          ctx,
          canonicalChatId,
          parsedScope,
          transport,
          trace,
          handlerStart,
        );
      } finally {
        this.runningCronTaskKeys.delete(taskKey);
      }

      return;
    }

    await this.handleCronDelivery(
      ctx,
      canonicalChatId,
      parsedScope,
      transport,
      trace,
      handlerStart,
    );
  }

  private async handleCronDelivery(
    ctx: TCronJobContext,
    canonicalChatId: string,
    parsedScope: { platform: EMessagePlatform; chatId: string },
    transport: TMessageTransport,
    trace: TBehaviorTraceContext,
    handlerStart: number,
  ) {
    let text: TOption<string>;
    let memoryPrefix = "CRON REMINDER";

    if (ctx.taskPrompt !== undefined) {
      const taskResult = await generateScheduledTaskText(
        ctx,
        parsedScope.platform,
        formatCommandList(),
        this.ai,
        trace,
      );
      text = taskResult.text;
      memoryPrefix = "CRON TASK";
      logCronTaskCompleted(trace, taskResult);
    } else {
      text = await generateReminderText(
        ctx,
        parsedScope.platform,
        formatCommandList(),
        this.llm,
        trace,
      );
    }

    if (text === undefined) {
      this.logger.info(`handleCronFire: job "${ctx.name}" has no reminder text, skipping delivery`);
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        0,
        "missing reminder text",
        undefined,
      );
      return;
    }

    if (text.trim().length === 0) {
      this.logger.info(
        `handleCronFire: job "${ctx.name}" has blank reminder text, skipping delivery`,
      );
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        0,
        "blank reminder text",
        undefined,
      );
      return;
    }

    const sendError = await this.messaging.sendText(transport, parsedScope.chatId, text, trace);
    if (sendError !== undefined) {
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        text.length,
        "send failed",
        sendError,
      );
      return;
    }

    const deliveredAt = Date.now();
    const saveStart = performance.now();

    try {
      await MessageHandler.getInstance(canonicalChatId).saveDeliveredMessage(
        `[${memoryPrefix} ${ctx.name}]: ${text}`,
        parsedScope.platform,
        deliveredAt,
      );
      logMemorySaveCompleted(
        trace,
        saveStart,
        ERole.Assistant,
        EMemoryImportance.Low,
        text.length,
        undefined,
      );
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to save reminder "${ctx.name}" to memory for chat ${canonicalChatId}: ${String(error)}`,
      );
      logMemorySaveCompleted(
        trace,
        saveStart,
        ERole.Assistant,
        EMemoryImportance.Low,
        text.length,
        String(error),
      );
    }

    logHandlerCompleted(
      trace,
      "cron-fire",
      handlerStart,
      true,
      text.length,
      "completed",
      undefined,
    );
  }
}

function logCronTaskCompleted(trace: TBehaviorTraceContext, result: TScheduledTaskResult) {
  AppLogger.instance.record({
    trace,
    event: "cron.task.completed",
    component: "messaging",
    success: result.text !== undefined && result.text.trim().length > 0,
    durationMs: result.durationMs,
    summary: "scheduled task completed",
    metadata: {
      mode: "task",
      iterations: result.iterations,
      toolCallCount: result.toolCallCount,
      stopReason: result.stopReason ?? "threw",
      deliveredTextChars: result.text?.length ?? 0,
    },
  });
}
