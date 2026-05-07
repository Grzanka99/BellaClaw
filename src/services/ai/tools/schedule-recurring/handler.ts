import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";
import { CronSingleton } from "../../../cron";
import type { TCronJob } from "../../../cron/types";

export const SScheduleRecurringArgs = z.object({
  name: z.string(),
  pattern: z.string(),
  group: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export type TScheduleRecurringArgs = z.infer<typeof SScheduleRecurringArgs>;

export type TScheduleRecurringResult = TCronJob;

export async function handleScheduleRecurring(
  toolCall: ChatMessageToolCall,
  chatId: string,
): Promise<TOption<TScheduleRecurringResult>> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse schedule-recurring arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SScheduleRecurringArgs.safeParse(argsJson);
  if (!parsed.success) {
    logger.error("handleScheduleRecurring: Zod validation failed");
    return undefined;
  }

  const args = parsed.data;

  const result = await CronSingleton.instance.schedule({
    name: args.name,
    userId: chatId,
    pattern: args.pattern,
    group: args.group,
    overwrite: args.overwrite,
  });

  if ("error" in result) {
    logger.error(`schedule-recurring failed: ${String(result.error)}`);
    return undefined;
  }

  return result;
}
