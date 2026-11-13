import { beforeEach, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { DatabaseConnector } from "../src/services/database";
import { eventDeliveriesTable, eventsTable } from "../src/services/database/schema";
import { resetEventTables } from "../src/services/database/test-utils";
import { EEventType } from "../src/services/events/catalog";
import { listDeadDeliveries, redriveDeliveries } from "./redrive-events";

const db = DatabaseConnector.instance.database;

beforeEach(async () => {
  await resetEventTables();
  await db.insert(eventsTable).values({
    id: "dead-event",
    type: EEventType.TestNoted,
    kind: "event",
    source: "test",
    key: "chat",
    turnId: "test:redrive",
    payload: { text: "note", count: 1 },
    occurredAt: new Date(),
  });
  await db.insert(eventDeliveriesTable).values([
    {
      eventSeq: 1,
      consumer: "dead-one",
      status: "dead",
      attempts: 3,
      lastError: "Error: boom",
      updatedAt: new Date(),
    },
    { eventSeq: 1, consumer: "done-one", status: "done", attempts: 0, updatedAt: new Date() },
  ]);
});

test("lists dead deliveries and sets chosen ones back to pending with no attempts", async () => {
  expect(
    (await listDeadDeliveries(db)).map((dead) => [dead.eventSeq, dead.consumer, dead.type]),
  ).toEqual([[1, "dead-one", EEventType.TestNoted]]);

  const redriven = await redriveDeliveries(db, [
    { eventSeq: 1, consumer: "dead-one" },
    { eventSeq: 1, consumer: "done-one" },
  ]);

  expect(redriven).toBe(1);
  const rows = await db
    .select()
    .from(eventDeliveriesTable)
    .orderBy(asc(eventDeliveriesTable.consumer));
  expect(rows.map((row) => [row.consumer, row.status, row.attempts, row.lastError])).toEqual([
    ["dead-one", "pending", 0, null],
    ["done-one", "done", 0, null],
  ]);
});
