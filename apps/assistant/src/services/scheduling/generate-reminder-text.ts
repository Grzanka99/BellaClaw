import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import type { AgentHarness } from "../ai/agent-harness";
import baseInstructions from "../ai/instructions/base-system.xml" with { type: "text" };
import { createPlatformInstructions } from "../ai/instructions/platform";
import { readXmlAndInjectConfig } from "../ai/instructions/read-xml-and-inject-config";
import type { LlmClient } from "../ai/llm";
import { EModelPurpose } from "../ai/types";
import type { TEventRequester } from "../events";
import type { TCronFiredPayload } from "../events/catalog";
import type { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../settings/schema";

type TReminderAi = Pick<LlmClient, "completeText">;
export type TScheduledTaskAi = Pick<AgentHarness, "runScheduledTask">;

export type TScheduledTaskResult = {
  text: TOption<string>;
  stopReason: TOption<string>;
  iterations: number;
  toolCallCount: number;
  durationMs: number;
};

const logger = createLogger("REMINDER");

export async function resolveCronScopeContext(ctx: TCronFiredPayload, logPrefix: string) {
  let timezone: TOption<string> = ctx.timezone;
  let settings: TConfigRecord = DefaultConfigRecord;

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

  if (timezone === undefined) {
    timezone = DefaultConfigRecord[EConfigKey.AiInstructionsTimezone];
  }

  return { settings, timezone };
}

export async function generateReminderText(
  ctx: TCronFiredPayload,
  platform: TOption<EMessagePlatform>,
  ai: TReminderAi,
  trace: TBehaviorTraceContext,
): Promise<TOption<string>> {
  const content = ctx.content;

  if (content.kind === "text") {
    return content.text.trim();
  }

  if (content.kind !== "generated") {
    return undefined;
  }

  const { settings, timezone } = await resolveCronScopeContext(ctx, "generateReminderText");

  try {
    const instructions = [
      readXmlAndInjectConfig(baseInstructions, settings),
      "Generate one reminder message from the provided reminder payload and firing context. Use the firing context for any date, time, or weekday-relative wording. Return only the final reminder text with no quotes or explanation.",
    ];
    const platformInstructions = createPlatformInstructions(platform);

    if (platformInstructions !== undefined) {
      instructions.push(platformInstructions);
    }

    const generatedText = await ai.completeText({
      prompt: [
        "Reminder prompt data JSON:",
        content.promptData,
        "",
        "Firing context JSON:",
        JSON.stringify(createFiringContext(new Date(ctx.nextRunAt), timezone)),
      ].join("\n"),
      instructions: instructions.join("\n\n"),
      purpose: EModelPurpose.Main,
      settings,
      trace,
    });

    if (generatedText !== undefined && generatedText.trim().length > 0) {
      return generatedText.trim();
    }

    logger.warning(`generateReminderText: empty reminder for job "${ctx.name}", using fallback`);
    return content.fallback;
  } catch (error) {
    logger.error(`generateReminderText: failed for job "${ctx.name}": ${String(error)}`);
    return content.fallback;
  }
}

export async function generateScheduledTaskText(
  ctx: TCronFiredPayload,
  platform: TOption<EMessagePlatform>,
  ai: TScheduledTaskAi,
  events: TEventRequester,
  trace: TBehaviorTraceContext,
  automationOutputs?: string,
): Promise<TScheduledTaskResult> {
  const startedAt = performance.now();

  const content = ctx.content;

  const toResult = (
    text: TOption<string>,
    run: Pick<TScheduledTaskResult, "stopReason" | "iterations" | "toolCallCount">,
  ): TScheduledTaskResult => ({
    text,
    stopReason: run.stopReason,
    iterations: run.iterations,
    toolCallCount: run.toolCallCount,
    durationMs: performance.now() - startedAt,
  });
  const noRun = { stopReason: undefined, iterations: 0, toolCallCount: 0 };

  if (content.kind !== "task") {
    return toResult(undefined, noRun);
  }

  const { settings, timezone } = await resolveCronScopeContext(ctx, "generateScheduledTaskText");

  let prompt = content.prompt;
  if (automationOutputs !== undefined) {
    prompt = `${prompt}\n\n${automationOutputs}`;
  }

  try {
    const result = await ai.runScheduledTask({
      prompt,
      currentTimeContext: `Scheduled firing context JSON:\n${JSON.stringify(createFiringContext(new Date(ctx.nextRunAt), timezone))}`,
      chatId: ctx.scope,
      settings,
      platform,
      trace,
      events,
      signal: undefined,
    });

    if (result.text !== undefined && result.text.trim().length > 0) {
      return toResult(result.text, result);
    }

    return toResult(content.fallback, result);
  } catch (error) {
    logger.error(`generateScheduledTaskText: failed for job "${ctx.name}": ${String(error)}`);
    return toResult(content.fallback, noRun);
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
