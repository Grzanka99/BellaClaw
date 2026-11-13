import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { AsyncQueue, createLogger, type TOption } from "@bellaclaw/shared";
import { and, asc, eq, inArray, lt, ne, notExists } from "drizzle-orm";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { startSpan } from "../app-logger/span";
import { DatabaseConnector, type TDatabaseTransaction } from "../database";
import { eventDeliveriesTable, eventsTable, type TSelectEvent } from "../database/schema";
import {
  EEventKind,
  EEventType,
  ERejectionCode,
  EVENT_KINDS,
  EVENT_SCHEMAS,
  EVENT_SCRUBBED,
  type TEvent,
  type TEventPayloads,
} from "./catalog";

export enum ESubscriptionMode {
  Durable = "durable", // delivery row, retries, replay on boot
  Live = "live", // in memory only, never replayed
}

export type TEventDraft<T extends EEventType = EEventType> = {
  type: T;
  source: string;
  key: string;
  trace: TBehaviorTraceContext;
  payload: TEventPayloads[T];
  causationId: TOption<string>;
  dedupeKey: TOption<string>;
};

export type TEmit = <T extends EEventType>(draft: TEventDraft<T>) => void;

// Follow-up of the handled event: inherits trace and key, sets causationId, and gets dedupeKey
// `${cause.id}:${consumer}:${type}:${step}`, so a redelivered handler cannot publish the same
// follow-up twice.
// key: the ordering key of the follow-up; undefined keeps the cause's key
export type TDerivedEmit = <T extends EEventType>(
  type: T,
  payload: TEventPayloads[T],
  step: TOption<string>,
  key: TOption<string>,
) => void;

export type TRequestOptions<O extends EEventType> = {
  outcome: O;
  step: TOption<string>;
  // ordering key of the command; undefined keeps the cause's key
  key: TOption<string>;
  // default 60 s
  timeoutMs: TOption<number>;
};

export type TEventContext = {
  // rows + follow-ups in one transaction, without the ack
  transact: <R>(work: (tx: TDatabaseTransaction, emit: TDerivedEmit) => Promise<R>) => Promise<R>;
  // rows + follow-ups + ack of this delivery in one transaction
  complete: <R>(work: (tx: TDatabaseTransaction, emit: TDerivedEmit) => Promise<R>) => Promise<R>;
  // the follow-up of this event that was already published, if any
  findCaused: <T extends EEventType>(type: T, step: TOption<string>) => Promise<TOption<TEvent<T>>>;
  // publishes a command and waits for its outcome event
  request: <C extends EEventType, O extends EEventType>(
    type: C,
    payload: TEventPayloads[C],
    options: TRequestOptions<O>,
  ) => Promise<TEvent<O>>;
  // waits for a fact caused by an event this handler already knows
  waitFor: <O extends EEventType>(
    causationId: string,
    type: O,
    timeoutMs: TOption<number>,
  ) => Promise<TEvent<O>>;
};

// the part of a handler's context that tools and agent runs get
export type TEventRequester = Pick<TEventContext, "request" | "waitFor">;

export type TSubscribeArgs<T extends EEventType> = {
  consumer: string;
  type: T;
  mode: ESubscriptionMode;
  backoffMs: number[]; // [] means one attempt
  handler: (event: TEvent<T>, ctx: TEventContext) => Promise<void>;
};

type TSubscription = {
  consumer: string;
  type: EEventType;
  mode: ESubscriptionMode;
  backoffMs: number[];
  run: (row: TSelectEvent) => Promise<void>;
};

type TWaiter = {
  type: EEventType;
  settle: (row: TSelectEvent) => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// boot prunes older events whose deliveries are all done
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

class InvalidPayloadError extends Error {}

export class CommandRejectedError extends Error {
  public constructor(
    public readonly code: ERejectionCode,
    message: string,
    public readonly errorCode: TOption<string>,
  ) {
    super(message);
  }
}

export class CommandTimeoutError extends Error {}

// the command.rejected payload of a handler that failed with error
export function commandFailed(
  commandType: EEventType,
  error: unknown,
): TEventPayloads[EEventType.CommandRejected] {
  let message = String(error);

  if (error instanceof Error) {
    message = error.message;
  }

  return { commandType, code: ERejectionCode.Failed, message: sanitizeErrorMessage(message) ?? "" };
}

function traceOf(row: TSelectEvent): TBehaviorTraceContext {
  return {
    turnId: row.turnId,
    chatId: row.chatId ?? undefined,
    platform: row.platform ?? undefined,
  };
}

function causedKey(causeId: string, consumer: string, type: EEventType, step: TOption<string>) {
  return `${causeId}:${consumer}:${type}:${step ?? ""}`;
}

export class EventBus {
  private static _instance: EventBus;
  private logger = createLogger("EVENTS");
  private subscriptions: TSubscription[] = [];
  private lanes = new Map<string, AsyncQueue>();
  private inFlight = new Set<Promise<void>>();
  // keyed by the causationId of the awaited event
  private waiters = new Map<string, Set<TWaiter>>();
  private started = false;
  private stopping = false;

  public static get instance() {
    if (!EventBus._instance) {
      EventBus._instance = new EventBus();
    }

    return EventBus._instance;
  }

  public subscribe<T extends EEventType>(subscription: TSubscribeArgs<T>): void {
    const taken = this.subscriptions.some(
      (existing) =>
        existing.consumer === subscription.consumer && existing.type === subscription.type,
    );

    // one delivery row per event and consumer
    if (taken) {
      throw new Error(`${subscription.consumer} already subscribes to ${subscription.type}`);
    }

    const schema = EVENT_SCHEMAS[subscription.type];

    this.subscriptions.push({
      consumer: subscription.consumer,
      type: subscription.type,
      mode: subscription.mode,
      backoffMs: subscription.backoffMs,
      // the closure keeps T, so the stored list needs no generic and no cast
      run: async (row) => {
        const parsed = schema.safeParse(row.payload);

        if (!parsed.success) {
          // NOTE: zod messages can quote the stored values, so only paths and codes are kept
          const issues = parsed.error.issues.map(
            (issue) => `${issue.path.join(".")}:${issue.code}`,
          );
          throw new InvalidPayloadError(`Invalid payload: ${issues.join(", ")}`);
        }

        let acked = false;
        const complete = async <R>(
          work: (tx: TDatabaseTransaction, emit: TDerivedEmit) => Promise<R>,
        ): Promise<R> => {
          const value = await this.transact(async (tx, emit) => {
            const result = await work(tx, this.derive(emit, row, subscription.consumer));

            if (subscription.mode === ESubscriptionMode.Durable) {
              await this.ack(tx, row, subscription.consumer);
            }

            return result;
          });
          acked = true;
          return value;
        };

        try {
          await subscription.handler(this.toEvent(row, subscription.type, parsed.data), {
            transact: (work) =>
              this.transact((tx, emit) => work(tx, this.derive(emit, row, subscription.consumer))),
            complete,
            findCaused: (type, step) => this.findCaused(row, subscription.consumer, type, step),
            request: (type, payload, options) =>
              this.request(row, subscription.consumer, type, payload, options),
            waitFor: (causationId, type, timeoutMs) => this.waitFor(causationId, type, timeoutMs),
          });
        } catch (error) {
          // the delivery is already acked: a retry would repeat its effects
          if (acked) {
            this.logger.error(
              `${subscription.consumer} failed on ${row.id} after its ack: ${String(error)}`,
            );
            return;
          }

          throw error;
        }

        // acks a durable delivery whose handler returned without calling ctx.complete (an early
        // return, a skip)
        if (subscription.mode === ESubscriptionMode.Durable && !acked) {
          await complete(async () => undefined);
        }
      },
    });
  }

  // NOTE: never call from inside DatabaseConnector.run or a transaction body: it deadlocks
  public transact<R>(work: (tx: TDatabaseTransaction, emit: TEmit) => Promise<R>): Promise<R> {
    return DatabaseConnector.instance.run(async (db) => {
      const drafts: TEventDraft[] = [];
      let appended: TSelectEvent[] = [];

      const result = await db.transaction(async (tx) => {
        const value = await work(tx, (draft) => {
          drafts.push(draft);
        });

        appended = await this.append(tx, drafts);
        return value;
      });

      // NOTE: still inside the run callback, after commit. Lanes are filled in commit order
      // here, so lane order equals seq order. Before start() nothing is dispatched: the rows
      // wait in the table and start() loads them.
      this.afterCommit(appended);

      return result;
    });
  }

  public publish<T extends EEventType>(draft: TEventDraft<T>): Promise<void> {
    return this.transact(async (_tx, emit) => {
      emit(draft);
    });
  }

  // validate, apply the boot rules, replay
  public async start(): Promise<void> {
    for (const type of Object.values(EEventType)) {
      if (EVENT_KINDS[type] !== EEventKind.Command) {
        continue;
      }

      const consumers = this.subscriptions.filter(
        (subscription) =>
          subscription.type === type && subscription.mode === ESubscriptionMode.Durable,
      );

      // zero is not checked here: test-only commands have none in the app, and a missing
      // consumer only times out its requester
      if (consumers.length > 1) {
        throw new Error(`Command ${type} has ${consumers.length} durable consumers, expected 1`);
      }
    }

    // NOTE: one run callback, so no publish can slip between the boot steps
    await DatabaseConnector.instance.run(async (db) => {
      const replay: { subscription: TSubscription; row: TSelectEvent; attempts: number }[] = [];
      let appended: TSelectEvent[] = [];

      await db.transaction(async (tx) => {
        // retention: dead and pending deliveries keep their event
        const expired = tx
          .select({ seq: eventsTable.seq })
          .from(eventsTable)
          .where(
            and(
              lt(eventsTable.occurredAt, new Date(Date.now() - EVENT_RETENTION_MS)),
              notExists(
                tx
                  .select()
                  .from(eventDeliveriesTable)
                  .where(
                    and(
                      eq(eventDeliveriesTable.eventSeq, eventsTable.seq),
                      ne(eventDeliveriesTable.status, "done"),
                    ),
                  ),
              ),
            ),
          );
        await tx
          .delete(eventDeliveriesTable)
          .where(inArray(eventDeliveriesTable.eventSeq, expired));
        await tx.delete(eventsTable).where(inArray(eventsTable.seq, expired));

        const pending = await tx
          .select({ event: eventsTable, delivery: eventDeliveriesTable })
          .from(eventDeliveriesTable)
          .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
          .where(eq(eventDeliveriesTable.status, "pending"))
          .orderBy(asc(eventDeliveriesTable.eventSeq));
        const drafts: TEventDraft[] = [];

        for (const { event, delivery } of pending) {
          const subscription = this.subscriptions.find(
            (candidate) =>
              candidate.consumer === delivery.consumer &&
              candidate.type === event.type &&
              candidate.mode === ESubscriptionMode.Durable,
          );

          if (subscription === undefined) {
            await this.markDead(tx, delivery.consumer, event, delivery.attempts, "no consumer");
            continue;
          }

          // its requester is gone; a repeated request revives it
          if (EVENT_KINDS[event.type] === EEventKind.Command) {
            await this.markDead(tx, delivery.consumer, event, delivery.attempts, "abandoned");
            continue;
          }

          if (delivery.attempts >= subscription.backoffMs.length + 1) {
            // the last attempt died with the process
            const error = delivery.lastError ?? "interrupted";
            await this.markDead(tx, delivery.consumer, event, delivery.attempts, error);

            // a dead dead-letter gets no dead-letter of its own, or it would loop
            if (event.type !== EEventType.EventDeadLettered) {
              drafts.push(this.deadLetterDraft(delivery.consumer, event, delivery.attempts, error));
            }

            continue;
          }

          // a handler that kills the process cannot loop forever
          const attempts = delivery.attempts + 1;
          await tx
            .update(eventDeliveriesTable)
            .set({ attempts, updatedAt: new Date() })
            .where(
              and(
                eq(eventDeliveriesTable.eventSeq, event.seq),
                eq(eventDeliveriesTable.consumer, delivery.consumer),
              ),
            );
          replay.push({ subscription, row: event, attempts });
        }

        appended = await this.append(tx, drafts);
      });

      this.started = true;
      this.logger.info(`Started, replaying ${replay.length} pending deliveries`);

      for (const { subscription, row, attempts } of replay) {
        this.enqueue(subscription, row, attempts);
      }

      this.afterCommit(appended);
    });
  }

  // resolves when every lane is empty; for tests
  public async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all(this.inFlight);
    }
  }

  // no new handler starts; waits for the open transaction
  public async stop(): Promise<void> {
    this.stopping = true;
    await DatabaseConnector.instance.run(async () => undefined);
  }

  private async append(tx: TDatabaseTransaction, drafts: TEventDraft[]): Promise<TSelectEvent[]> {
    const appended: TSelectEvent[] = [];

    for (const draft of drafts) {
      const [row] = await tx
        .insert(eventsTable)
        .values({
          id: Bun.randomUUIDv7(),
          type: draft.type,
          kind: EVENT_KINDS[draft.type],
          source: draft.source,
          key: draft.key,
          turnId: draft.trace.turnId,
          chatId: draft.trace.chatId,
          platform: draft.trace.platform,
          causationId: draft.causationId,
          dedupeKey: draft.dedupeKey,
          payload: draft.payload,
          occurredAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      // a duplicate dedupeKey stores nothing and dispatches nothing
      if (row === undefined) {
        continue;
      }

      for (const subscription of this.subscriptions) {
        if (subscription.type !== row.type || subscription.mode !== ESubscriptionMode.Durable) {
          continue;
        }

        await tx.insert(eventDeliveriesTable).values({
          eventSeq: row.seq,
          consumer: subscription.consumer,
          updatedAt: new Date(),
        });
      }

      appended.push(row);
    }

    return appended;
  }

  private afterCommit(appended: TSelectEvent[]): void {
    for (const row of appended) {
      AppLogger.instance.record({
        trace: traceOf(row),
        event: "event.published",
        component: row.source,
        metadata: { eventId: row.id, eventType: row.type, causationId: row.causationId },
      });
    }

    if (!this.started) {
      return;
    }

    for (const row of appended) {
      for (const subscription of this.subscriptions) {
        if (subscription.type === row.type) {
          this.enqueue(subscription, row, 0);
        }
      }
    }

    for (const row of appended) {
      if (row.causationId === null) {
        continue;
      }

      for (const waiter of this.waiters.get(row.causationId) ?? []) {
        if (waiter.type === row.type || row.type === EEventType.CommandRejected) {
          waiter.settle(row);
        }
      }
    }
  }

  private enqueue(subscription: TSubscription, row: TSelectEvent, startAttempts: number): void {
    const laneKey = `${subscription.consumer}\u0000${row.key}`;
    let lane = this.lanes.get(laneKey);

    if (lane === undefined) {
      lane = new AsyncQueue();
      this.lanes.set(laneKey, lane);
    }

    // deliver never rejects: a failing handler cannot break its lane, another consumer, or the
    // publisher
    const task = lane
      .enqueue(() => this.deliver(subscription, row, startAttempts))
      .catch((error) => {
        this.logger.error(`Delivery of ${row.id} to ${subscription.consumer} broke: ${error}`);
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  private async deliver(subscription: TSubscription, row: TSelectEvent, startAttempts: number) {
    let attempts = startAttempts;

    while (!this.stopping) {
      const span = startSpan(traceOf(row), "event.handled", subscription.consumer, {
        metadata: {
          eventId: row.id,
          eventType: row.type,
          causationId: row.causationId,
          consumer: subscription.consumer,
          attempt: attempts + 1,
        },
      });

      try {
        await subscription.run(row);
        span.ok();
        return;
      } catch (error) {
        span.fail(String(error));
        attempts += 1;
        const backoff = subscription.backoffMs[attempts - 1];

        if (backoff === undefined || error instanceof InvalidPayloadError) {
          await this.deadLetter(subscription, row, attempts, String(error));
          return;
        }

        await this.recordFailure(subscription, row, attempts, String(error));
        // the lane stays blocked while waiting: order matters more than throughput
        await Bun.sleep(backoff);
      }
    }
  }

  private async recordFailure(
    subscription: TSubscription,
    row: TSelectEvent,
    attempts: number,
    error: string,
  ): Promise<void> {
    if (subscription.mode === ESubscriptionMode.Live) {
      return;
    }

    await DatabaseConnector.instance.run((db) =>
      db
        .update(eventDeliveriesTable)
        .set({ attempts, lastError: sanitizeErrorMessage(error), updatedAt: new Date() })
        .where(
          and(
            eq(eventDeliveriesTable.eventSeq, row.seq),
            eq(eventDeliveriesTable.consumer, subscription.consumer),
            eq(eventDeliveriesTable.status, "pending"),
          ),
        ),
    );
  }

  private async deadLetter(
    subscription: TSubscription,
    row: TSelectEvent,
    attempts: number,
    error: string,
  ): Promise<void> {
    AppLogger.instance.record({
      trace: traceOf(row),
      event: "event.dead_lettered",
      component: subscription.consumer,
      level: EBehaviorLogLevel.Error,
      error: sanitizeErrorMessage(error),
      metadata: {
        eventId: row.id,
        eventType: row.type,
        causationId: row.causationId,
        consumer: subscription.consumer,
        attempt: attempts,
      },
    });

    // a live subscription has no delivery row to mark and nothing to replay
    if (subscription.mode === ESubscriptionMode.Live) {
      return;
    }

    await this.transact(async (tx, emit) => {
      const marked = await this.markDead(tx, subscription.consumer, row, attempts, error);

      // a dead dead-letter gets no dead-letter of its own, or it would loop
      if (marked && row.type !== EEventType.EventDeadLettered) {
        emit(this.deadLetterDraft(subscription.consumer, row, attempts, error));
      }

      // fails the waiter at once instead of at its timeout
      if (marked && EVENT_KINDS[row.type] === EEventKind.Command) {
        const type = EEventType.CommandRejected;
        emit({
          type,
          source: "events",
          key: row.key,
          trace: traceOf(row),
          payload: {
            commandType: row.type,
            code: ERejectionCode.Failed,
            message: sanitizeErrorMessage(error) ?? "",
          },
          causationId: row.id,
          dedupeKey: causedKey(row.id, subscription.consumer, type, undefined),
        });
      }
    });
  }

  private async markDead(
    tx: TDatabaseTransaction,
    consumer: string,
    row: TSelectEvent,
    attempts: number,
    error: string,
  ): Promise<boolean> {
    const result = await tx
      .update(eventDeliveriesTable)
      .set({
        status: "dead",
        attempts,
        lastError: sanitizeErrorMessage(error),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(eventDeliveriesTable.eventSeq, row.seq),
          eq(eventDeliveriesTable.consumer, consumer),
          eq(eventDeliveriesTable.status, "pending"),
        ),
      );

    // NOTE: a scrubbed event that ends dead cannot be redriven
    if (EVENT_SCRUBBED.has(row.type)) {
      await this.scrubIfSettled(tx, row.seq);
    }

    return result.rowsAffected === 1;
  }

  private deadLetterDraft(
    consumer: string,
    row: TSelectEvent,
    attempts: number,
    error: string,
  ): TEventDraft<EEventType.EventDeadLettered> {
    const type = EEventType.EventDeadLettered;

    return {
      type,
      source: "events",
      key: row.key,
      trace: traceOf(row),
      payload: {
        eventId: row.id,
        eventType: row.type,
        consumer,
        attempts,
        error: sanitizeErrorMessage(error) ?? "",
      },
      causationId: row.id,
      dedupeKey: causedKey(row.id, consumer, type, undefined),
    };
  }

  private async ack(tx: TDatabaseTransaction, row: TSelectEvent, consumer: string): Promise<void> {
    const acked = await tx
      .update(eventDeliveriesTable)
      .set({ status: "done", updatedAt: new Date() })
      .where(
        and(
          eq(eventDeliveriesTable.eventSeq, row.seq),
          eq(eventDeliveriesTable.consumer, consumer),
          eq(eventDeliveriesTable.status, "pending"),
        ),
      );

    // a delivery that was redriven, abandoned or already acked must not commit
    if (acked.rowsAffected !== 1) {
      throw new Error("delivery is no longer pending");
    }

    if (EVENT_SCRUBBED.has(row.type)) {
      await this.scrubIfSettled(tx, row.seq);
    }
  }

  // drops the payload once no delivery of the event is pending
  private async scrubIfSettled(tx: TDatabaseTransaction, seq: number): Promise<void> {
    await tx
      .update(eventsTable)
      .set({ payload: null })
      .where(
        and(
          eq(eventsTable.seq, seq),
          notExists(
            tx
              .select()
              .from(eventDeliveriesTable)
              .where(
                and(
                  eq(eventDeliveriesTable.eventSeq, seq),
                  eq(eventDeliveriesTable.status, "pending"),
                ),
              ),
          ),
        ),
      );
  }

  private derive(emit: TEmit, cause: TSelectEvent, consumer: string): TDerivedEmit {
    return (type, payload, step, key) => {
      emit({
        type,
        source: consumer,
        key: key ?? cause.key,
        trace: traceOf(cause),
        payload,
        causationId: cause.id,
        dedupeKey: causedKey(cause.id, consumer, type, step),
      });
    };
  }

  private async findCaused<T extends EEventType>(
    cause: TSelectEvent,
    consumer: string,
    type: T,
    step: TOption<string>,
  ): Promise<TOption<TEvent<T>>> {
    const [row] = await DatabaseConnector.instance.run((db) =>
      db
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.dedupeKey, causedKey(cause.id, consumer, type, step))),
    );

    if (row === undefined) {
      return undefined;
    }

    const parsed = EVENT_SCHEMAS[type].safeParse(row.payload);

    if (!parsed.success) {
      throw new Error(`Stored payload of ${type} ${row.id} is invalid: ${parsed.error.message}`);
    }

    return this.toEvent(row, type, parsed.data);
  }

  private async request<C extends EEventType, O extends EEventType>(
    cause: TSelectEvent,
    consumer: string,
    type: C,
    payload: TEventPayloads[C],
    options: TRequestOptions<O>,
  ): Promise<TEvent<O>> {
    const dedupeKey = causedKey(cause.id, consumer, type, options.step);

    await this.transact(async (_tx, emit) => {
      this.derive(emit, cause, consumer)(type, payload, options.step, options.key);
    });

    // on a dedupe hit the stored command is used; one abandoned at boot is dispatched again
    const command = await DatabaseConnector.instance.run(async (db) => {
      const [stored] = await db
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.dedupeKey, dedupeKey));

      if (stored === undefined) {
        throw new Error(`Command ${type} was not stored`);
      }

      // a command whose answer is already stored needs no second run
      const [answered] = await db
        .select({ seq: eventsTable.seq })
        .from(eventsTable)
        .where(
          and(
            eq(eventsTable.causationId, stored.id),
            inArray(eventsTable.type, [options.outcome, EEventType.CommandRejected]),
          ),
        )
        .limit(1);

      if (answered !== undefined) {
        return stored;
      }

      const revived = await db
        .update(eventDeliveriesTable)
        .set({ status: "pending", lastError: null, updatedAt: new Date() })
        .where(
          and(
            eq(eventDeliveriesTable.eventSeq, stored.seq),
            eq(eventDeliveriesTable.status, "dead"),
            eq(eventDeliveriesTable.lastError, "abandoned"),
          ),
        )
        .returning();

      if (revived.length === 0) {
        return stored;
      }

      let restored = stored;

      // a scrubbed command lost its payload when it was abandoned; the requester brings it again
      if (EVENT_SCRUBBED.has(stored.type)) {
        await db.update(eventsTable).set({ payload }).where(eq(eventsTable.seq, stored.seq));
        restored = { ...stored, payload };
      }

      for (const delivery of revived) {
        const subscription = this.subscriptions.find(
          (candidate) =>
            candidate.consumer === delivery.consumer &&
            candidate.type === stored.type &&
            candidate.mode === ESubscriptionMode.Durable,
        );

        if (subscription !== undefined) {
          this.enqueue(subscription, restored, delivery.attempts);
        }
      }

      return stored;
    });

    return this.waitFor(command.id, options.outcome, options.timeoutMs);
  }

  // NOTE: the waiter is registered before the log is read, so an outcome committed in between
  // is not missed
  private async waitFor<O extends EEventType>(
    causationId: string,
    type: O,
    timeoutMs: TOption<number>,
  ): Promise<TEvent<O>> {
    const { promise, resolve, reject } = Promise.withResolvers<TEvent<O>>();
    let waiters = this.waiters.get(causationId);

    if (waiters === undefined) {
      waiters = new Set();
      this.waiters.set(causationId, waiters);
    }

    const registered = waiters;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      registered.delete(waiter);

      if (registered.size === 0) {
        this.waiters.delete(causationId);
      }
    };
    const waiter: TWaiter = {
      type,
      settle: (row) => {
        if (settled) {
          return;
        }

        finish();

        if (row.type === EEventType.CommandRejected) {
          const rejected = EVENT_SCHEMAS[EEventType.CommandRejected].safeParse(row.payload);

          if (!rejected.success) {
            reject(new Error(`Stored rejection ${row.id} is invalid: ${rejected.error.message}`));
            return;
          }

          reject(
            new CommandRejectedError(
              rejected.data.code,
              rejected.data.message,
              rejected.data.errorCode,
            ),
          );
          return;
        }

        const parsed = EVENT_SCHEMAS[type].safeParse(row.payload);

        if (!parsed.success) {
          reject(
            new Error(`Stored payload of ${type} ${row.id} is invalid: ${parsed.error.message}`),
          );
          return;
        }

        resolve(this.toEvent(row, type, parsed.data));
      },
    };
    const limit = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      finish();
      reject(new CommandTimeoutError(`No ${type} for ${causationId} within ${limit} ms`));
    }, limit);
    registered.add(waiter);

    const [stored] = await DatabaseConnector.instance.run((db) =>
      db
        .select()
        .from(eventsTable)
        .where(
          and(
            eq(eventsTable.causationId, causationId),
            inArray(eventsTable.type, [type, EEventType.CommandRejected]),
          ),
        )
        .orderBy(asc(eventsTable.seq))
        .limit(1),
    );

    if (stored !== undefined) {
      waiter.settle(stored);
    }

    return promise;
  }

  private toEvent<T extends EEventType>(
    row: TSelectEvent,
    type: T,
    payload: TEventPayloads[T],
  ): TEvent<T> {
    return {
      id: row.id,
      seq: row.seq,
      type,
      kind: EVENT_KINDS[type],
      source: row.source,
      key: row.key,
      occurredAt: row.occurredAt.getTime(),
      trace: traceOf(row),
      causationId: row.causationId ?? undefined,
      dedupeKey: row.dedupeKey ?? undefined,
      payload,
    };
  }
}
