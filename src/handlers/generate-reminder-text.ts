import { Config } from "../config";
import type { TCronJobContext } from "../lib/cron-engine";
import type { AiConnector } from "../services/ai/api";
import { readXmlAndInjectConfig } from "../services/ai/instructions/read-xml-and-inject-config";
import { EAssistantLoopStopReason } from "../services/ai/runtime";
import { webFetchTool } from "../services/ai/tools/web-fetch/definition";
import { webSearchTool } from "../services/ai/tools/web-search/definition";
import { EModelPurpose, ERole, type THistoryItem, type TPrompt } from "../services/ai/types";
import type { TBehaviorTraceContext } from "../services/app-logger";
import { parseCanonicalChatKey } from "../services/messaging/chat-key";
import type { EMessagePlatform } from "../services/messaging/types";
import { SettingsService } from "../services/settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../services/settings/schema";
import type { TOption } from "../types";
import { createLogger } from "../utils/logger";

type TReminderAi = Pick<AiConnector, "runToolTask">;
type TScheduledTaskAi = Pick<AiConnector, "runAssistantToolLoop">;

export type TScheduledTaskResult = {
  text: TOption<string>;
  stopReason: TOption<EAssistantLoopStopReason>;
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

  const { settings, timezone, platform } = await resolveCronScopeContext(
    ctx,
    "generateReminderText",
  );

  const history: THistoryItem[] = [
    {
      role: ERole.System,
      content:
        "Generate one reminder message from the provided reminder payload and firing context. Use the firing context for any date, time, or weekday-relative wording. Return only the final reminder text with no quotes or explanation.",
    },
  ];

  const prompt: TPrompt = {
    role: ERole.User,
    content: [
      {
        type: "text",
        text: [
          "Reminder prompt data JSON:",
          ctx.reminderPromptData,
          "",
          "Firing context JSON:",
          JSON.stringify(createFiringContext(ctx.nextRunAt, timezone)),
        ].join("\n"),
      },
    ],
  };

  try {
    const res = await ai.runToolTask({
      prompt,
      history,
      tools: [],
      purpose: EModelPurpose.ChatAccurate,
      chatId: undefined,
      user: undefined,
      settings,
      platform,
      trace,
    });

    const generatedText = res.assistantResponse.trim();
    if (generatedText.length > 0) {
      return generatedText;
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
    const [taskInstructions, webSearchInstructions, webFetchInstructions] = await Promise.all([
      readXmlAndInjectConfig("./src/handlers/scheduled-task-instructions.xml", settings),
      readXmlAndInjectConfig("./src/services/ai/tools/web-search/instructions.xml", settings),
      readXmlAndInjectConfig("./src/services/ai/tools/web-fetch/instructions.xml", settings),
    ]);
    const result = await ai.runAssistantToolLoop({
      prompt: {
        role: ERole.User,
        content: [{ type: "text", text: ctx.taskPrompt }],
      },
      history: [{ role: ERole.System, content: taskInstructions }],
      currentTimeContext: `Scheduled firing context JSON:\n${JSON.stringify(createFiringContext(ctx.nextRunAt, timezone))}`,
      tools: [
        { definition: webSearchTool, instructions: webSearchInstructions },
        { definition: webFetchTool, instructions: webFetchInstructions },
      ],
      purpose: EModelPurpose.ChatAccurate,
      chatId: ctx.scope,
      user: undefined,
      settings,
      platform,
      trace,
      maxIterations: 4,
    });
    const toolCallCount = result.toolActivity.reduce(
      (count, activity) => count + activity.toolCalls.length,
      0,
    );

    if (
      (result.stopReason === EAssistantLoopStopReason.FinalResponse ||
        result.stopReason === EAssistantLoopStopReason.MaxIterations) &&
      result.finalResponse !== undefined &&
      result.finalResponse.trim().length > 0
    ) {
      return {
        text: result.finalResponse,
        stopReason: result.stopReason,
        iterations: result.iterations,
        toolCallCount,
        durationMs: performance.now() - startedAt,
      };
    }

    return {
      text: ctx.taskFallbackText,
      stopReason: result.stopReason,
      iterations: result.iterations,
      toolCallCount,
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
