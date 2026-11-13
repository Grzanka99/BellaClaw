import { EEventType } from "../events/catalog";
import { testEventRequester } from "../events/test-utils";
import {
  fromCronJobRecord,
  type TCreateOnceArgs,
  type TCreateRecurringArgs,
  type TCronJob,
} from "./types";

// the cron commands the schedule tools send; a rejection throws CommandRejectedError

export async function createRecurring(args: TCreateRecurringArgs): Promise<TCronJob> {
  const scheduled = await testEventRequester.request(
    EEventType.CronJobScheduleRequested,
    { ...args, automationIds: args.automationIds ?? [] },
    {
      outcome: EEventType.CronJobScheduled,
      step: undefined,
      key: args.scope,
      timeoutMs: undefined,
    },
  );

  return fromCronJobRecord(scheduled.payload.job);
}

export async function createOnce(args: TCreateOnceArgs): Promise<TCronJob> {
  const scheduled = await testEventRequester.request(
    EEventType.CronJobScheduleRequested,
    { ...args, automationIds: args.automationIds ?? [], fireAt: args.fireAt.getTime() },
    {
      outcome: EEventType.CronJobScheduled,
      step: undefined,
      key: args.scope,
      timeoutMs: undefined,
    },
  );

  return fromCronJobRecord(scheduled.payload.job);
}

export async function cancelJob(name: string, scope: string): Promise<TCronJob> {
  const cancelled = await testEventRequester.request(
    EEventType.CronJobCancelRequested,
    { name, scope },
    { outcome: EEventType.CronJobCancelled, step: undefined, key: scope, timeoutMs: undefined },
  );

  return fromCronJobRecord(cancelled.payload.job);
}
