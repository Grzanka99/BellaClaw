import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { z } from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";
import { CronSingleton } from "../../../cron";
import type { TCronJob } from "../../../cron/types";

export const SListCronJobsArgs = z.object({});

export type TListCronJobsArgs = z.infer<typeof SListCronJobsArgs>;

export type TListCronJobsResult = TCronJob[];

export async function handleListCronJobs(
  toolCall: ChatMessageToolCall,
  chatId: string,
): Promise<TOption<TListCronJobsResult>> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse list-cron-jobs arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SListCronJobsArgs.safeParse(argsJson);
  if (!parsed.success) {
    logger.error("handleListCronJobs: Zod validation failed");
    return undefined;
  }

  const jobs = await CronSingleton.instance.getAllJobs(chatId);

  return jobs;
}
