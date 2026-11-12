import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";

export enum EEventKind {
  Event = "event",
  Command = "command",
}

export enum EEventType {
  EventDeadLettered = "event.dead_lettered",
  // NOTE: test types for the bus tests; real types arrive with their phase
  TestNoted = "test.noted",
  TestSecret = "test.secret",
}

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
  [EEventType.EventDeadLettered]: z.infer<typeof SEventDeadLettered>;
  [EEventType.TestNoted]: z.infer<typeof STestNoted>;
  [EEventType.TestSecret]: z.infer<typeof STestSecret>;
};

// The mapped type ties each schema to its payload type, so a handler gets a typed payload
// without a cast.
export const EVENT_SCHEMAS: { [K in EEventType]: z.ZodType<TEventPayloads[K]> } = {
  [EEventType.EventDeadLettered]: SEventDeadLettered,
  [EEventType.TestNoted]: STestNoted,
  [EEventType.TestSecret]: STestSecret,
};

export const EVENT_KINDS: Record<EEventType, EEventKind> = {
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
