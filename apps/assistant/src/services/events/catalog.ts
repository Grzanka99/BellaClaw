import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { ECronJobType } from "../cron/types";

export enum EEventKind {
  Event = "event",
  Command = "command",
}

export enum EEventType {
  ReplyReady = "reply.ready",
  NoticeReady = "notice.ready",
  DeliveryReady = "delivery.ready",
  MessageSent = "message.sent",
  CronFired = "cron.fired",
  CronTaskStarted = "cron.task.started",
  McpAuthConnected = "mcp.auth.connected",
  AiAuthLoginNeeded = "ai.auth.login.needed",
  AiAuthLoginCompleted = "ai.auth.login.completed",
  AiAuthLoginFailed = "ai.auth.login.failed",
  EventDeadLettered = "event.dead_lettered",
  // NOTE: test types for the bus tests; real types arrive with their phase
  TestNoted = "test.noted",
  TestSecret = "test.secret",
}

const STranscript = z.object({ text: z.string(), notice: z.string() }).strict();

export type TDeliveryTranscript = z.infer<typeof STranscript>;

const SReplyReady = z
  .object({ chatId: z.string(), text: z.string(), transcript: STranscript.optional() })
  .strict();

const SNoticeReady = z.object({ chatId: z.string(), text: z.string() }).strict();

const SDeliveryReady = z
  .object({ chatId: z.string(), text: z.string(), transcript: STranscript })
  .strict();

const SMessageSent = z
  .object({
    chatId: z.string(),
    sourceType: z.string(),
    chars: z.number().int(),
    sentAt: z.number().int(),
    transcript: STranscript.optional(),
  })
  .strict();

const SJobContent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("generated"), promptData: z.string(), fallback: z.string() }).strict(),
  z.object({ kind: z.literal("task"), prompt: z.string(), fallback: z.string() }).strict(),
  z.object({ kind: z.literal("automations") }).strict(),
]);

const SCronFired = z
  .object({
    jobId: z.number().int(),
    name: z.string(),
    scope: z.string(),
    jobType: z.enum(ECronJobType),
    pattern: z.string().optional(),
    content: SJobContent,
    automationIds: z.array(z.number().int()),
    nextRunAt: z.number().int(),
    timezone: z.string().optional(),
  })
  .strict();

export type TCronFiredPayload = z.infer<typeof SCronFired>;

const SCronTaskStarted = z.object({ jobId: z.number().int() }).strict();

const SMcpAuthConnected = z.object({ chatId: z.string(), profileId: z.string() }).strict();

const SAiAuthLoginNeeded = z.object({ problems: z.array(z.string()) }).strict();

const SAiAuthLoginCompleted = z
  .object({ chatId: z.string(), providerId: z.string(), selected: z.boolean() })
  .strict();

const SAiAuthLoginFailed = z
  .object({ chatId: z.string(), providerId: z.string(), error: z.string() })
  .strict();

const SEventDeadLettered = z
  .object({
    eventId: z.string(),
    eventType: z.string(),
    consumer: z.string(),
    attempts: z.number().int(),
    error: z.string(),
  })
  .strict();

const STestNoted = z.object({ text: z.string(), count: z.number().int() }).strict();
const STestSecret = z.object({ secret: z.string() }).strict();

export type TEventPayloads = {
  [EEventType.ReplyReady]: z.infer<typeof SReplyReady>;
  [EEventType.NoticeReady]: z.infer<typeof SNoticeReady>;
  [EEventType.DeliveryReady]: z.infer<typeof SDeliveryReady>;
  [EEventType.MessageSent]: z.infer<typeof SMessageSent>;
  [EEventType.CronFired]: TCronFiredPayload;
  [EEventType.CronTaskStarted]: z.infer<typeof SCronTaskStarted>;
  [EEventType.McpAuthConnected]: z.infer<typeof SMcpAuthConnected>;
  [EEventType.AiAuthLoginNeeded]: z.infer<typeof SAiAuthLoginNeeded>;
  [EEventType.AiAuthLoginCompleted]: z.infer<typeof SAiAuthLoginCompleted>;
  [EEventType.AiAuthLoginFailed]: z.infer<typeof SAiAuthLoginFailed>;
  [EEventType.EventDeadLettered]: z.infer<typeof SEventDeadLettered>;
  [EEventType.TestNoted]: z.infer<typeof STestNoted>;
  [EEventType.TestSecret]: z.infer<typeof STestSecret>;
};

// The mapped type ties each schema to its payload type, so a handler gets a typed payload
// without a cast.
export const EVENT_SCHEMAS: { [K in EEventType]: z.ZodType<TEventPayloads[K]> } = {
  [EEventType.ReplyReady]: SReplyReady,
  [EEventType.NoticeReady]: SNoticeReady,
  [EEventType.DeliveryReady]: SDeliveryReady,
  [EEventType.MessageSent]: SMessageSent,
  [EEventType.CronFired]: SCronFired,
  [EEventType.CronTaskStarted]: SCronTaskStarted,
  [EEventType.McpAuthConnected]: SMcpAuthConnected,
  [EEventType.AiAuthLoginNeeded]: SAiAuthLoginNeeded,
  [EEventType.AiAuthLoginCompleted]: SAiAuthLoginCompleted,
  [EEventType.AiAuthLoginFailed]: SAiAuthLoginFailed,
  [EEventType.EventDeadLettered]: SEventDeadLettered,
  [EEventType.TestNoted]: STestNoted,
  [EEventType.TestSecret]: STestSecret,
};

export const EVENT_KINDS: Record<EEventType, EEventKind> = {
  [EEventType.ReplyReady]: EEventKind.Event,
  [EEventType.NoticeReady]: EEventKind.Event,
  [EEventType.DeliveryReady]: EEventKind.Event,
  [EEventType.MessageSent]: EEventKind.Event,
  [EEventType.CronFired]: EEventKind.Event,
  [EEventType.CronTaskStarted]: EEventKind.Event,
  [EEventType.McpAuthConnected]: EEventKind.Event,
  [EEventType.AiAuthLoginNeeded]: EEventKind.Event,
  [EEventType.AiAuthLoginCompleted]: EEventKind.Event,
  [EEventType.AiAuthLoginFailed]: EEventKind.Event,
  [EEventType.EventDeadLettered]: EEventKind.Event,
  [EEventType.TestNoted]: EEventKind.Event,
  [EEventType.TestSecret]: EEventKind.Event,
};

// payload set to NULL once the last delivery of the event completes
export const EVENT_SCRUBBED: ReadonlySet<EEventType> = new Set([EEventType.TestSecret]);

export type TEvent<T extends EEventType = EEventType> = {
  id: string;
  seq: number;
  type: T;
  kind: EEventKind;
  source: string;
  key: string;
  occurredAt: number;
  trace: TBehaviorTraceContext;
  causationId: TOption<string>;
  dedupeKey: TOption<string>;
  payload: TEventPayloads[T];
};
