import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { EEventType } from "@bellaclaw/database";
import { CommandRejectedError, ESubscriptionMode, EventBus } from "../events";
import type { TEventPayloads } from "../events/catalog";

export const COMMAND_TIMEOUT_MS = 60_000;
// NOTE: a delete waits on the chat's lane behind a running turn and its compaction. Just under
// the gateway's 250 s wait for this API, so the gateway gets the answer.
export const DELETE_TIMEOUT_MS = 240_000;

// the outcome facts of the commands the API publishes
type TOutcomeType =
  | EEventType.SettingsChanged
  | EEventType.ConversationMessageDeleted
  | EEventType.IdentityLinkStarted
  | EEventType.ConversationCreated
  | EEventType.ConversationDeleted
  | EEventType.AppDeviceRegistered
  | EEventType.AppDeviceUnregistered;

const OUTCOME_TYPES: TOutcomeType[] = [
  EEventType.SettingsChanged,
  EEventType.ConversationMessageDeleted,
  EEventType.IdentityLinkStarted,
  EEventType.ConversationCreated,
  EEventType.ConversationDeleted,
  EEventType.AppDeviceRegistered,
  EEventType.AppDeviceUnregistered,
];

// a command waiting for its outcome: settled by its outcome type or by command.rejected
type TPendingOutcome = {
  type: TOutcomeType;
  resolve(payload: TEventPayloads[TOutcomeType]): void;
  reject(error: Error): void;
};

// commands waiting for their outcome, by the turn id of the command
const pending = new Map<string, TPendingOutcome>();

// NOTE: a request is no bus handler, so it has no ctx.request. It publishes the command under a
// turn id of its own and these live subscriptions settle it: the outcome inherits the trace.
export function setupInternalApi(): void {
  const bus = EventBus.instance;

  for (const type of OUTCOME_TYPES) {
    bus.subscribe({
      consumer: "internal-api",
      type,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        const waiter = pending.get(event.trace.turnId);

        if (waiter?.type === event.type) {
          waiter.resolve(event.payload);
        }
      },
    });
  }

  bus.subscribe({
    consumer: "internal-api",
    type: EEventType.CommandRejected,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      const { code, message, errorCode } = event.payload;
      pending.get(event.trace.turnId)?.reject(new CommandRejectedError(code, message, errorCode));
    },
  });
}

// publishes a command on the key's lane and waits for the outcome the live subscriptions settle.
// toResult: what the request answers with, from the outcome's payload
export async function requestOutcome<T extends EEventType, O extends TOutcomeType, R>(
  trace: TBehaviorTraceContext,
  key: string,
  type: T,
  payload: TEventPayloads[T],
  outcomeType: O,
  toResult: (outcomePayload: TEventPayloads[O]) => R,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<R> {
  const outcome = Promise.withResolvers<R>();
  pending.set(trace.turnId, {
    type: outcomeType,
    resolve: (outcomePayload: TEventPayloads[O]) => outcome.resolve(toResult(outcomePayload)),
    reject: outcome.reject,
  });
  const timer = setTimeout(() => {
    outcome.reject(new Error(timeoutMessage));
  }, timeoutMs);

  try {
    const [result] = await Promise.all([
      outcome.promise,
      EventBus.instance.publish({
        type,
        source: "internal-api",
        key,
        trace,
        payload,
        causationId: undefined,
        dedupeKey: undefined,
      }),
    ]);

    return result;
  } finally {
    clearTimeout(timer);
    pending.delete(trace.turnId);
  }
}
