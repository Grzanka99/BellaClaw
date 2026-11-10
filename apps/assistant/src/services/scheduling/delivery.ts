import { AppLogger, createCronTurnId, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import type { TCronJobContext } from "../../lib/cron-engine";
import { AgentHarness } from "../ai/agent-harness";
import { LlmClient } from "../ai/llm";
import { ERole } from "../ai/types";
import {
  logHandlerStarted,
  startHandlerSpan,
  startMemorySaveSpan,
  type THandlerSpan,
} from "../app-logger/operations";
import { CronSingleton } from "../cron";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { parseCanonicalChatKey } from "../messaging/chat-key";
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
    logHandlerStarted(trace, "cron-fire");
    const span = startHandlerSpan(trace, "cron-fire");

    const canonicalChatId = ctx.scope;
    if (canonicalChatId === undefined) {
      this.logger.warning(`handleCronFire: job "${ctx.name}" has no scope, skipping delivery`);
      span.fail("missing scope", 0);
      return;
    }

    const parsedScope = parseCanonicalChatKey(canonicalChatId);
    if (parsedScope === undefined) {
      this.logger.warning(
        `handleCronFire: job "${ctx.name}" has invalid scope "${canonicalChatId}", skipping delivery`,
      );
      span.fail("invalid scope", 0);
      return;
    }

    trace.platform = parsedScope.platform;

    const transport = await this.messaging.waitForTransport(parsedScope.platform);
    if (transport === undefined) {
      this.logger.warning(
        `handleCronFire: no ${parsedScope.platform} transport for reminder "${ctx.name}", skipping delivery`,
      );
      span.fail("missing transport", 0);
      return;
    }

    if (ctx.taskPrompt !== undefined) {
      const taskKey = JSON.stringify([canonicalChatId, ctx.name]);

      if (this.runningCronTaskKeys.has(taskKey)) {
        this.logger.warning(`handleCronFire: task "${ctx.name}" is already running, skipping`);
        span.ok("task overlap skipped", 0);
        return;
      }

      this.runningCronTaskKeys.add(taskKey);

      try {
        await this.handleCronDelivery(ctx, canonicalChatId, parsedScope, transport, trace, span);
      } finally {
        this.runningCronTaskKeys.delete(taskKey);
      }

      return;
    }

    await this.handleCronDelivery(ctx, canonicalChatId, parsedScope, transport, trace, span);
  }

  private async handleCronDelivery(
    ctx: TCronJobContext,
    canonicalChatId: string,
    parsedScope: { platform: EMessagePlatform; chatId: string },
    transport: TMessageTransport,
    trace: TBehaviorTraceContext,
    span: THandlerSpan,
  ) {
    let text: TOption<string>;
    let memoryPrefix = "CRON REMINDER";

    if (ctx.taskPrompt !== undefined) {
      const taskResult = await generateScheduledTaskText(ctx, parsedScope.platform, this.ai, trace);
      text = taskResult.text;
      memoryPrefix = "CRON TASK";
      logCronTaskCompleted(trace, taskResult);
    } else {
      text = await generateReminderText(ctx, parsedScope.platform, this.llm, trace);
    }

    if (text === undefined) {
      this.logger.info(`handleCronFire: job "${ctx.name}" has no reminder text, skipping delivery`);
      span.fail("missing reminder text", 0);
      return;
    }

    if (text.trim().length === 0) {
      this.logger.info(
        `handleCronFire: job "${ctx.name}" has blank reminder text, skipping delivery`,
      );
      span.fail("blank reminder text", 0);
      return;
    }

    const sendError = await this.messaging.sendText(transport, parsedScope.chatId, text, trace);
    if (sendError !== undefined) {
      span.fail("send failed", text.length, sendError);
      return;
    }

    const deliveredAt = Date.now();
    const saveSpan = startMemorySaveSpan(trace, ERole.Assistant, text.length);

    try {
      await MessageHandler.getInstance(canonicalChatId).saveDeliveredMessage(
        `[${memoryPrefix} ${ctx.name}]: ${text}`,
        deliveredAt,
      );
      saveSpan.ok();
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to save reminder "${ctx.name}" to memory for chat ${canonicalChatId}: ${String(error)}`,
      );
      saveSpan.fail(String(error));
    }

    span.ok("completed", text.length);
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
