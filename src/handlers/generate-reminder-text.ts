import { Config } from "../config";
import type { TCronJobContext } from "../lib/cron-engine";
import type { AgentHarness } from "../services/ai/agent-harness";
import { EModelPurpose } from "../services/ai/types";
import type { TBehaviorTraceContext } from "../services/app-logger";
import { parseCanonicalChatKey } from "../services/messaging/chat-key";
import type { EMessagePlatform } from "../services/messaging/types";
import { SettingsService } from "../services/settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../services/settings/schema";
import type { TOption } from "../types";
import { createLogger } from "../utils/logger";

type TReminderAi = Pick<AgentHarness, "completeText">;
type TScheduledTaskAi = Pick<AgentHarness, "runScheduledTask">;

export type TScheduledTaskResult = {
  text: TOption<string>;
  stopReason: TOption<string>;
  iterations: number;
  toolCallCount: number;
  durationMs: number;
};

const logger = createLogger("REMINDER");

async function resolveCronScopeContext(ctx: TCronJobContext, logPrefix: string) {
  let timezone: TOption<string> = ctx.timezone;
  let settings: TConfigRecord = DefaultConfigRecord;
  let platform: TOption<EMessagePlatform>;

  if (ctx.scope !== undefined) {
    const parsedScope = parseCanonicalChatKey(ctx.scope);
    if (parsedScope !== undefined) {
      platform = parsedScope.platform;
    }

    try {
      const loaded = await SettingsService.instance.getAll(ctx.scope);
      settings = loaded;

      if (timezone === undefined) {
        timezone = loaded[EConfigKey.AiInstructionsTimezone];
      }
    } catch (error) {
      logger.warning(
        `${logPrefix}: failed to load settings for scope "${ctx.scope}": ${String(error)}`,
      );
    }
  }

  if (timezone === undefined) {
    timezone = Config.ai.instructions.timezone;
  }

  return { settings, timezone, platform };
}

export async function generateReminderText(
  ctx: TCronJobContext,
  ai: TReminderAi,
  trace?: TBehaviorTraceContext,
): Promise<TOption<string>> {
  if (ctx.reminderText !== undefined) {
    const reminderText = ctx.reminderText.trim();

    if (reminderText.length > 0) {
      return reminderText;
    }

    logger.warning(
      `generateReminderText: empty reminderText for job "${ctx.name}", using fallback`,
    );
    return ctx.reminderFallbackText;
  }

  if (ctx.reminderPromptData === undefined) {
    return ctx.reminderFallbackText;
  }

  const { settings, timezone } = await resolveCronScopeContext(ctx, "generateReminderText");

  try {
    const generatedText = await ai.completeText({
      prompt: [
        "Reminder prompt data JSON:",
        ctx.reminderPromptData,
        "",
        "Firing context JSON:",
        JSON.stringify(createFiringContext(ctx.nextRunAt, timezone)),
      ].join("\n"),
      instructions:
        "Generate one reminder message from the provided reminder payload and firing context. Return only the final reminder text with no quotes or explanation.",
      purpose: EModelPurpose.ChatAccurate,
      settings,
      trace,
    });

    if (generatedText !== undefined && generatedText.trim().length > 0) {
      return generatedText.trim();
    }

    logger.warning(`generateReminderText: empty reminder for job "${ctx.name}", using fallback`);
    return ctx.reminderFallbackText;
  } catch (error) {
    logger.error(`generateReminderText: failed for job "${ctx.name}": ${String(error)}`);
    return ctx.reminderFallbackText;
  }
}

export async function generateScheduledTaskText(
  ctx: TCronJobContext,
  ai: TScheduledTaskAi,
  trace?: TBehaviorTraceContext,
): Promise<TScheduledTaskResult> {
  const startedAt = performance.now();

  if (ctx.taskPrompt === undefined || ctx.taskFallbackText === undefined) {
    return {
      text: undefined,
      stopReason: undefined,
      iterations: 0,
      toolCallCount: 0,
      durationMs: performance.now() - startedAt,
    };
  }

  const { settings, timezone, platform } = await resolveCronScopeContext(
    ctx,
    "generateScheduledTaskText",
  );

  try {
    const result = await ai.runScheduledTask({
      prompt: ctx.taskPrompt,
      history: undefined,
      currentTimeContext: `Scheduled firing context JSON:\n${JSON.stringify(createFiringContext(ctx.nextRunAt, timezone))}`,
      chatId: ctx.scope,
      settings,
      platform,
      trace,
    });

    if (result.text !== undefined && result.text.trim().length > 0) {
      return {
        text: result.text,
        stopReason: result.stopReason,
        iterations: result.iterations,
        toolCallCount: result.toolCallCount,
        durationMs: performance.now() - startedAt,
      };
    }

    return {
      text: ctx.taskFallbackText,
      stopReason: result.stopReason,
      iterations: result.iterations,
      toolCallCount: result.toolCallCount,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    logger.error(`generateScheduledTaskText: failed for job "${ctx.name}": ${String(error)}`);
    return {
      text: ctx.taskFallbackText,
      stopReason: undefined,
      iterations: 0,
      toolCallCount: 0,
      durationMs: performance.now() - startedAt,
    };
  }
}

function createFiringContext(fireAt: Date, timezone: string) {
  return {
    fireTimestamp: fireAt.toISOString(),
    timezone,
    localDateTime: fireAt.toLocaleString("sv-SE-u-nu-latn", {
      timeZone: timezone,
      hourCycle: "h23",
    }),
    localWeekday: fireAt.toLocaleString("en-US-u-nu-latn", {
      timeZone: timezone,
      weekday: "long",
    }),
  };
}
