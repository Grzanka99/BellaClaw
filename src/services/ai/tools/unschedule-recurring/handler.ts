import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";
import { CronSingleton } from "../../../cron";
import type { TCronJob } from "../../../cron/types";

export const SUnscheduleRecurringArgs = z.object({
  name: z.string(),
});

export type TUnscheduleRecurringArgs = z.infer<typeof SUnscheduleRecurringArgs>;

export type TUnscheduleRecurringResult = TCronJob;

export async function handleUnscheduleRecurring(
  toolCall: ChatMessageToolCall,
  chatId: string,
): Promise<TOption<TUnscheduleRecurringResult>> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse unschedule-recurring arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SUnscheduleRecurringArgs.safeParse(argsJson);
  if (!parsed.success) {
    logger.error("handleUnscheduleRecurring: Zod validation failed");
    return undefined;
  }

  const args = parsed.data;

  const result = await CronSingleton.instance.unschedule(args.name, chatId);

  if ("error" in result) {
    logger.error(`unschedule-recurring failed: ${String(result.error)}`);
    return undefined;
  }

  return result;
}
