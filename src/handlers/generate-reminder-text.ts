import { Config } from "../config";
import type { TCronEngineJobContext } from "../lib/cron-engine";
import type { AiConnector } from "../services/ai/api";
import { EModelPurpose, ERole, type THistoryItem, type TPrompt } from "../services/ai/types";
import type { TOption } from "../types";
import { createLogger } from "../utils/logger";

type TReminderAi = Pick<AiConnector, "runToolTask">;

const logger = createLogger("REMINDER");

export async function generateReminderText(
  ctx: TCronEngineJobContext,
  ai: TReminderAi,
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
          JSON.stringify(createFiringContext(ctx.nextRunAt)),
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

function createFiringContext(fireAt: Date) {
  const timezone = Config.ai.instructions.timezone;

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
