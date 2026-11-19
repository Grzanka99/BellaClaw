import { AppLogger, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { EEventType } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { AgentHarness } from "../ai/agent-harness";
import { LlmClient } from "../ai/llm";
import { logHandlerStarted, startHandlerSpan, type THandlerSpan } from "../app-logger/operations";
import { AUTOMATION_RUN_TIMEOUT_MS, EAutomationRunMode } from "../automation/runner";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import type {
  TAutomationRunReport,
  TCronFiredPayload,
  TDeliveryTranscript,
  TEvent,
} from "../events/catalog";
import { IdentityService } from "../identity";
import type { EMessagePlatform } from "../messaging/types";
import {
  createAutomationFailedNotices,
  createAutomationPausedNotices,
  runCronJobAutomations,
  type TCronAutomationsResult,
} from "./cron-automations";
import {
  generateReminderText,
  generateScheduledTaskText,
  type TScheduledTaskResult,
} from "./generate-reminder-text";

type TCronMessage = { text: string; transcript: TDeliveryTranscript };

export class ScheduledDelivery {
  private static _instance: TOption<ScheduledDelivery>;
  private logger: TLogger = createLogger("SCHEDULING");
  private ai = AgentHarness.instance;
  private llm = LlmClient.instance;
  // end of the last heavy run per lane key (scope|name)
  private lastRunEndedAt = new Map<string, number>();

  private constructor() {}

  public static get instance() {
    if (!ScheduledDelivery._instance) {
      ScheduledDelivery._instance = new ScheduledDelivery();
    }

    return ScheduledDelivery._instance;
  }

  public setup(): void {
    EventBus.instance.subscribe({
      consumer: "scheduling",
      type: EEventType.CronFired,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: (event, ctx) => this.handleCronFire(event, ctx),
    });
  }

  private async handleCronFire(event: TEvent<EEventType.CronFired>, ctx: TEventContext) {
    // NOTE: a fire for a scope that is being linked waits for the link on its own lane, bounded
    // from the fire as an inbound message is, so it runs once, for the account
    if (!(await IdentityService.instance.waitWhileLinking(event.payload.scope, event.occurredAt))) {
      throw new Error("The link of this job's owner did not complete in time");
    }

    // the scope is the job's owner; the delivery goes to the owner's conversation, and its text is
    // formatted for the channel that conversation is reached on
    const resolved = await IdentityService.instance.resolve(event.payload.scope);
    const trace: TBehaviorTraceContext = {
      ...event.trace,
      platform: resolved?.destination.channel,
    };
    logHandlerStarted(trace, "cron-fire");
    const span = startHandlerSpan(trace, "cron-fire");

    if (resolved === undefined) {
      this.logger.warning(
        `handleCronFire: job "${event.payload.name}" has invalid scope "${event.payload.scope}", skipping delivery`,
      );
      span.fail("invalid scope", 0);
      return;
    }

    // a fire queued under an address that is linked since runs, like the job's row, for the
    // account: its automations, settings and tools are the account's
    const job = { ...event.payload, scope: resolved.ownerKey };

    const conversationKey = resolved.conversationKey;
    const destination = resolved.destination;

    let messages: TCronMessage[];

    if (job.content.kind === "task" || job.automationIds.length > 0) {
      // NOTE: accepted risk: keyed by scope|name, so a run that outlasts its interval can overlap
      // the next fire once when a link re-keys the job mid-run
      const previousEnd = this.lastRunEndedAt.get(event.key);

      // fired while the previous run of this job was still going
      if (previousEnd !== undefined && event.occurredAt < previousEnd) {
        this.logger.warning(`handleCronFire: task "${job.name}" is already running, skipping`);
        span.ok("task overlap skipped", 0);
        return;
      }

      let interrupted = false;

      // an earlier attempt died mid-run: the agent never runs twice. A replayed fire of
      // automations alone runs again and reuses the stored reports of finished runs
      if (job.content.kind === "task") {
        interrupted = (await ctx.findCaused(EEventType.CronTaskStarted, undefined)) !== undefined;

        if (!interrupted) {
          await ctx.transact(async (_tx, emit) => {
            emit(EEventType.CronTaskStarted, { jobId: job.jobId }, undefined, undefined);
          });
        }
      }

      try {
        messages = await this.createCronMessages(
          job,
          conversationKey,
          destination.channel,
          trace,
          span,
          interrupted,
          ctx,
        );
      } finally {
        this.lastRunEndedAt.set(event.key, Date.now());
      }
    } else {
      messages = await this.createCronMessages(
        job,
        conversationKey,
        destination.channel,
        trace,
        span,
        false,
        ctx,
      );
    }

    if (messages.length === 0) {
      return;
    }

    await ctx.complete(async (_tx, emit) => {
      for (const [index, message] of messages.entries()) {
        emit(
          EEventType.DeliveryReady,
          { chatId: conversationKey, text: message.text, transcript: message.transcript },
          String(index),
          // the chat lane, so the transcript append orders with the chat's turns
          conversationKey,
        );
      }
    });
  }

  private async createCronMessages(
    job: TCronFiredPayload,
    conversationKey: string,
    platform: EMessagePlatform,
    trace: TBehaviorTraceContext,
    span: THandlerSpan,
    interrupted: boolean,
    ctx: TEventContext,
  ): Promise<TCronMessage[]> {
    const messages: TCronMessage[] = [];
    let text: TOption<string>;
    let memoryPrefix = "CRON REMINDER";
    let toolCallCount: TOption<number>;

    if (interrupted) {
      memoryPrefix = "CRON TASK";

      // only a task has fallback text
      if (job.content.kind === "task") {
        text = job.content.fallback;
        toolCallCount = 0;
      }
    } else if (job.automationIds.length > 0) {
      memoryPrefix = "CRON TASK";
      let result: TOption<TCronAutomationsResult>;

      try {
        result = await runCronJobAutomations(
          job,
          conversationKey,
          platform,
          this.ai,
          ctx,
          async (automation, options) => {
            const completed = await ctx.request(
              EEventType.AutomationRunRequested,
              {
                scope: job.scope,
                automationId: automation.id,
                mode: EAutomationRunMode.Cron,
                timezone: options.timezone,
              },
              {
                outcome: EEventType.AutomationRunCompleted,
                // a replayed fire gets the stored report of a finished run
                step: String(automation.id),
                key: job.scope,
                timeoutMs: AUTOMATION_RUN_TIMEOUT_MS,
              },
            );

            return completed.payload.report;
          },
          trace,
        );
      } catch (error) {
        this.logger.error(
          `handleCronFire: automations of job "${job.name}" failed: ${String(error)}`,
        );
      }

      let reports: TAutomationRunReport[] = [];

      if (result !== undefined) {
        text = result.text;
        reports = result.reports;

        if (result.taskResult !== undefined) {
          toolCallCount = result.taskResult.toolCallCount;
          logCronTaskCompleted(trace, result.taskResult);
        }
      } else if (job.content.kind === "task") {
        text = job.content.fallback;
        toolCallCount = 0;
      }

      const notices = createAutomationPausedNotices(reports).map((notice) => {
        return { notice, event: "paused a failing automation" };
      });

      // A task's message covers failures; a job that sends outputs as written needs a notice.
      if (job.content.kind === "automations") {
        for (const notice of createAutomationFailedNotices(reports)) {
          notices.push({ notice, event: "had an automation fail" });
        }
      }

      for (const { notice, event } of notices) {
        messages.push(
          createCronMessage(
            job,
            memoryPrefix,
            notice,
            `scheduled job "${job.name}" ran at ${new Date().toISOString()} and ${event}. The next assistant message is that notice.`,
          ),
        );
      }

      if (text === undefined) {
        this.logger.info(`handleCronFire: job "${job.name}" has nothing to send`);
        span.ok("nothing to send", 0);
        return messages;
      }
    } else if (job.content.kind === "task") {
      const taskResult = await generateScheduledTaskText(
        job,
        conversationKey,
        platform,
        this.ai,
        ctx,
        trace,
      );
      text = taskResult.text;
      memoryPrefix = "CRON TASK";
      toolCallCount = taskResult.toolCallCount;
      logCronTaskCompleted(trace, taskResult);
    } else {
      text = await generateReminderText(job, platform, this.llm, trace);
    }

    if (text === undefined) {
      this.logger.info(`handleCronFire: job "${job.name}" has no reminder text, skipping delivery`);
      span.fail("missing reminder text", 0);
      return messages;
    }

    if (text.trim().length === 0) {
      this.logger.info(
        `handleCronFire: job "${job.name}" has blank reminder text, skipping delivery`,
      );
      span.fail("blank reminder text", 0);
      return messages;
    }

    // NOTE: the notice is built when the text is produced, not when it is sent
    const firedAt = new Date().toISOString();
    let notice = `reminder "${job.name}" fired at ${firedAt}. The next assistant message is its delivery.`;

    if (toolCallCount !== undefined) {
      notice = `scheduled task "${job.name}" ran at ${firedAt} as a separate agent run that made ${toolCallCount} tool calls, such as web searches, to produce the next assistant message.`;
      if (job.automationIds.length > 0) {
        notice = `${notice} It also used the outputs of the job's automations.`;
      }
    } else if (job.content.kind === "automations") {
      notice = `scheduled job "${job.name}" ran at ${firedAt}. The next assistant message is the text output of its automations, sent as written.`;
    }

    messages.push(createCronMessage(job, memoryPrefix, text, notice));
    span.ok("completed", text.length);
    return messages;
  }
}

function createCronMessage(
  job: TCronFiredPayload,
  memoryPrefix: string,
  text: string,
  notice: string,
): TCronMessage {
  return {
    text,
    transcript: {
      text: `[${memoryPrefix} ${job.name}]: ${text}`,
      notice: `Scheduler notice, not from the user: ${notice}`,
    },
  };
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
