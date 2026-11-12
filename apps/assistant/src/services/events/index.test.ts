import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { eventDeliveriesTable, eventsTable, messageAuthorizationsTable } from "../database/schema";
import { resetEventTables, resetMessageAuthorizationsTable } from "../database/test-utils";
import { EEventType, type TEventPayloads } from "./catalog";
import { ESubscriptionMode, EventBus, type TEventDraft } from "./index";

const trace = { turnId: "test:events", chatId: undefined, platform: undefined };

function noted(key: string, count: number, dedupeKey?: string): TEventDraft<EEventType.TestNoted> {
  return {
    type: EEventType.TestNoted,
    source: "test",
    key,
    trace,
    payload: { text: `note ${count}`, count },
    causationId: undefined,
    dedupeKey,
  };
}

function secret(): TEventDraft<EEventType.TestSecret> {
  return {
    type: EEventType.TestSecret,
    source: "test",
    key: "chat",
    trace,
    payload: { secret: "token" },
    causationId: undefined,
    dedupeKey: undefined,
  };
}

async function events() {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .orderBy(asc(eventsTable.seq));
}

async function deliveries() {
  return DatabaseConnector.instance.database
    .select()
    .from(eventDeliveriesTable)
    .orderBy(asc(eventDeliveriesTable.eventSeq), asc(eventDeliveriesTable.consumer));
}

async function deadLettered() {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.EventDeadLettered));
}

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(async () => {
    await resetEventTables();
    await resetMessageAuthorizationsTable();
    Object.assign(EventBus, { _instance: undefined });
    bus = EventBus.instance;
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
  });

  test("publish writes one event and one delivery per durable subscription", async () => {
    const live: number[] = [];

    for (const consumer of ["a", "b"]) {
      bus.subscribe({
        consumer,
        type: EEventType.TestNoted,
        mode: ESubscriptionMode.Durable,
        backoffMs: [],
        handler: async () => undefined,
      });
    }
    bus.subscribe({
      consumer: "c",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        live.push(event.payload.count);
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.idle();

    expect(await events()).toHaveLength(1);
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["a", "done"],
      ["b", "done"],
    ]);
    expect(live).toEqual([1]);
  });

  test("a handler receives a typed payload", async () => {
    const received: number[] = [];

    bus.subscribe({
      consumer: "typed",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event) => {
        // count is a number, not unknown
        received.push(event.payload.count + 1);
        expect(event.payload.text).toBe("note 41");
        expect(event.type).toBe(EEventType.TestNoted);
        expect(event.trace).toEqual(trace);
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 41));
    await bus.idle();

    expect(received).toEqual([42]);
  });

  test("a payload that fails its schema is dead-lettered without a retry", async () => {
    let calls = 0;

    bus.subscribe({
      consumer: "strict",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [5, 5],
      handler: async () => {
        calls += 1;
      },
    });
    await bus.start();

    await bus.publish({
      ...noted("chat", 1),
      payload: { text: 1 } as unknown as TEventPayloads[EEventType.TestNoted],
    });
    await bus.idle();

    expect(calls).toBe(0);
    const [delivery] = await deliveries();
    expect(delivery?.status).toBe("dead");
    expect(delivery?.attempts).toBe(1);
    expect(await deadLettered()).toHaveLength(1);
  });

  test("a throwing handler is retried, dead-lettered and does not stop another consumer", async () => {
    let failing = 0;
    let healthy = 0;

    bus.subscribe({
      consumer: "failing",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [5, 5],
      handler: async () => {
        failing += 1;
        throw new Error(`boom ${failing}`);
      },
    });
    bus.subscribe({
      consumer: "healthy",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async () => {
        healthy += 1;
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.idle();

    expect(failing).toBe(3);
    expect(healthy).toBe(1);
    const rows = await deliveries();
    expect(rows.map((row) => [row.consumer, row.status, row.attempts])).toEqual([
      ["failing", "dead", 3],
      ["healthy", "done", 0],
      // event.dead_lettered has no durable consumer here
    ]);
    expect(rows[0]?.lastError).toContain("boom 3");

    const [original] = await events();
    const [dead] = await deadLettered();
    expect(dead?.causationId).toBe(original?.id);
    expect(dead?.key).toBe("chat");
    expect(dead?.payload).toEqual({
      eventId: original?.id,
      eventType: EEventType.TestNoted,
      consumer: "failing",
      attempts: 3,
      error: "Error: boom 3",
    });
  });

  test("a handler that throws after its ack is not retried", async () => {
    let runs = 0;

    bus.subscribe({
      consumer: "acked",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [0],
      handler: async (_event, ctx) => {
        runs += 1;
        await ctx.complete(async () => undefined);
        throw new Error("after ack");
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.idle();

    expect(runs).toBe(1);
    const rows = await deliveries();
    expect(rows.map((row) => [row.consumer, row.status])).toEqual([["acked", "done"]]);
    expect(await deadLettered()).toHaveLength(0);
  });

  test("a failing dead-letter consumer does not dead-letter its own dead letters", async () => {
    bus.subscribe({
      consumer: "failing",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async () => {
        throw new Error("boom");
      },
    });
    bus.subscribe({
      consumer: "notices",
      type: EEventType.EventDeadLettered,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async () => {
        throw new Error("notice failed");
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.idle();

    expect(await deadLettered()).toHaveLength(1);
    const rows = await deliveries();
    expect(rows.map((row) => [row.consumer, row.status])).toEqual([
      ["failing", "dead"],
      ["notices", "dead"],
    ]);
  });

  test("the same key runs serially in seq order and different keys overlap", async () => {
    const log: string[] = [];
    const gate = Promise.withResolvers<void>();
    const otherKeyStarted = Promise.withResolvers<void>();

    bus.subscribe({
      consumer: "ordered",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event) => {
        log.push(`start ${event.payload.count}`);

        if (event.key === "other") {
          otherKeyStarted.resolve();
        }

        if (event.payload.count === 1) {
          await gate.promise;
        }

        log.push(`end ${event.payload.count}`);
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.publish(noted("chat", 2));
    await bus.publish(noted("other", 3));
    await otherKeyStarted.promise;

    expect(log).toContain("start 1");
    expect(log).not.toContain("end 1");
    expect(log).not.toContain("start 2");

    gate.resolve();
    await bus.idle();

    expect(log.filter((entry) => !entry.endsWith("3"))).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
    ]);
  });

  test("a duplicate dedupeKey stores one row and dispatches once", async () => {
    let calls = 0;

    bus.subscribe({
      consumer: "once",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async () => {
        calls += 1;
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1, "same"));
    await bus.publish(noted("chat", 2, "same"));
    await bus.idle();

    expect(await events()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("ctx.complete commits nothing when the work throws", async () => {
    const seen: string[] = [];

    bus.subscribe({
      consumer: "completer",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (_event, ctx) => {
        await ctx
          .complete(async (tx, emit) => {
            await tx
              .insert(messageAuthorizationsTable)
              .values({ chatId: "chat", status: "pending" });
            emit(EEventType.TestSecret, { secret: "follow-up" }, undefined);
            throw new Error("work failed");
          })
          .catch((error) => {
            seen.push(String(error));
          });

        const [delivery] = await DatabaseConnector.instance.run((db) =>
          db.select().from(eventDeliveriesTable),
        );
        seen.push(delivery?.status ?? "missing");
        throw new Error("stop here");
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.idle();

    expect(seen).toEqual(["Error: work failed", "pending"]);
    expect(
      await DatabaseConnector.instance.database.select().from(messageAuthorizationsTable),
    ).toEqual([]);
    expect((await events()).map((row) => row.type)).toEqual([
      EEventType.TestNoted,
      EEventType.EventDeadLettered,
    ]);
  });

  test("ctx.complete throws and rolls back when the delivery is not pending", async () => {
    const seen: string[] = [];

    bus.subscribe({
      consumer: "completer",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (_event, ctx) => {
        await ctx.complete(async () => undefined);
        await ctx
          .complete(async (tx, emit) => {
            await tx
              .insert(messageAuthorizationsTable)
              .values({ chatId: "chat", status: "pending" });
            emit(EEventType.TestSecret, { secret: "follow-up" }, undefined);
          })
          .catch((error) => {
            seen.push(String(error));
          });
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.idle();

    expect(seen).toEqual(["Error: delivery is no longer pending"]);
    expect(
      await DatabaseConnector.instance.database.select().from(messageAuthorizationsTable),
    ).toEqual([]);
    expect(await events()).toHaveLength(1);
    expect((await deliveries())[0]?.status).toBe("done");
  });

  test("a scrubbed type loses its payload after its last ack, not before", async () => {
    const firstAcked = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();

    bus.subscribe({
      consumer: "first",
      type: EEventType.TestSecret,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (_event, ctx) => {
        await ctx.complete(async () => undefined);
        firstAcked.resolve();
      },
    });
    bus.subscribe({
      consumer: "second",
      type: EEventType.TestSecret,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async () => {
        await gate.promise;
      },
    });
    await bus.start();

    await bus.publish(secret());
    await firstAcked.promise;

    expect((await events())[0]?.payload).toEqual({ secret: "token" });

    gate.resolve();
    await bus.idle();

    expect((await events())[0]?.payload).toBeNull();
  });

  test("a handler that calls transact does not deadlock the run queue", async () => {
    bus.subscribe({
      consumer: "nested",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (_event, ctx) => {
        await ctx.transact(async (_tx, emit) => {
          emit(EEventType.TestSecret, { secret: "derived" }, "step");
        });
        await EventBus.instance.transact(async (_tx, emit) => {
          emit(secret());
        });
        const caused = await ctx.findCaused(EEventType.TestSecret, "step");
        expect(caused?.payload).toEqual({ secret: "derived" });
      },
    });
    await bus.start();

    await bus.publish(noted("chat", 1));
    await bus.idle();

    const rows = await events();
    expect(rows.map((row) => row.type)).toEqual([
      EEventType.TestNoted,
      EEventType.TestSecret,
      EEventType.TestSecret,
    ]);
    expect(rows[1]?.causationId).toBe(rows[0]?.id);
    expect(rows[1]?.dedupeKey).toBe(`${rows[0]?.id}:nested:${EEventType.TestSecret}:step`);
    expect((await deliveries())[0]?.status).toBe("done");
  });

  test("start replays pending deliveries and applies the boot rules", async () => {
    const db = DatabaseConnector.instance.database;
    const pending: [string, number][] = [
      ["replay", 0],
      ["replay", 1],
      ["limited", 1],
      ["ghost", 0],
      ["limited", 0],
    ];

    for (const [index, [consumer, attempts]] of pending.entries()) {
      const [row] = await db
        .insert(eventsTable)
        .values({
          id: Bun.randomUUIDv7(),
          type: EEventType.TestNoted,
          kind: "event",
          source: "test",
          key: "chat",
          turnId: trace.turnId,
          payload: { text: consumer, count: index + 1 },
          occurredAt: new Date(),
        })
        .returning();

      if (row === undefined) {
        throw new Error("insert failed");
      }

      await db
        .insert(eventDeliveriesTable)
        .values({ eventSeq: row.seq, consumer, attempts, updatedAt: new Date() });
    }

    const ran: string[] = [];

    for (const [consumer, backoffMs] of [
      ["replay", [5, 5]],
      ["limited", []],
    ] as const) {
      bus.subscribe({
        consumer,
        type: EEventType.TestNoted,
        mode: ESubscriptionMode.Durable,
        backoffMs: [...backoffMs],
        handler: async (event) => {
          ran.push(`${consumer} ${event.payload.count}`);
        },
      });
    }
    await bus.start();
    await bus.idle();

    // different consumers run on different lanes, so only each consumer's order is fixed
    expect(ran.filter((entry) => entry.startsWith("replay"))).toEqual(["replay 1", "replay 2"]);
    expect(ran.filter((entry) => entry.startsWith("limited"))).toEqual(["limited 5"]);
    expect(
      (await deliveries()).map((row) => [row.consumer, row.status, row.attempts, row.lastError]),
    ).toEqual([
      ["replay", "done", 1, null],
      ["replay", "done", 2, null],
      ["limited", "dead", 1, "interrupted"],
      ["ghost", "dead", 0, "no consumer"],
      ["limited", "done", 1, null],
    ]);
    const dead = await deadLettered();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.payload).toMatchObject({ consumer: "limited", attempts: 1 });
  });

  test("an event published before start() is delivered once after it", async () => {
    let calls = 0;

    bus.subscribe({
      consumer: "late",
      type: EEventType.TestNoted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async () => {
        calls += 1;
      },
    });

    await bus.publish(noted("chat", 1));
    await bus.idle();

    expect(calls).toBe(0);
    expect((await deliveries())[0]?.status).toBe("pending");

    await bus.start();
    await bus.idle();

    expect(calls).toBe(1);
    expect((await deliveries())[0]?.status).toBe("done");
  });
});
