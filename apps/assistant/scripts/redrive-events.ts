import { logger } from "@bellaclaw/shared";
import { and, asc, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { DatabaseConnector } from "../src/services/database";
import { eventDeliveriesTable, eventsTable } from "../src/services/database/schema";

export function listDeadDeliveries(db: LibSQLDatabase) {
  return db
    .select({
      eventSeq: eventDeliveriesTable.eventSeq,
      consumer: eventDeliveriesTable.consumer,
      type: eventsTable.type,
      attempts: eventDeliveriesTable.attempts,
      lastError: eventDeliveriesTable.lastError,
      updatedAt: eventDeliveriesTable.updatedAt,
    })
    .from(eventDeliveriesTable)
    .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
    .where(eq(eventDeliveriesTable.status, "dead"))
    .orderBy(asc(eventDeliveriesTable.eventSeq), asc(eventDeliveriesTable.consumer));
}

// NOTE: the next boot replays the redriven rows; a redriven command is abandoned again there
export async function redriveDeliveries(
  db: LibSQLDatabase,
  targets: { eventSeq: number; consumer: string }[],
): Promise<number> {
  let redriven = 0;

  await db.transaction(async (tx) => {
    for (const target of targets) {
      const result = await tx
        .update(eventDeliveriesTable)
        .set({ status: "pending", attempts: 0, lastError: null, updatedAt: new Date() })
        .where(
          and(
            eq(eventDeliveriesTable.eventSeq, target.eventSeq),
            eq(eventDeliveriesTable.consumer, target.consumer),
            eq(eventDeliveriesTable.status, "dead"),
          ),
        );
      redriven += result.rowsAffected;
    }
  });

  return redriven;
}

// usage: no arguments lists dead deliveries; `<eventSeq>:<consumer>` arguments redrive them
if (import.meta.main) {
  const db = DatabaseConnector.instance.database;
  const args = Bun.argv.slice(2);

  if (args.length === 0) {
    for (const dead of await listDeadDeliveries(db)) {
      logger.info(
        `${dead.eventSeq}:${dead.consumer} ${dead.type} attempts=${dead.attempts} at=${dead.updatedAt.toISOString()} error=${dead.lastError ?? ""}`,
      );
    }
  } else {
    const targets: { eventSeq: number; consumer: string }[] = [];

    for (const arg of args) {
      const separator = arg.indexOf(":");
      const eventSeq = Number(arg.slice(0, separator));

      if (separator <= 0 || !Number.isInteger(eventSeq)) {
        logger.error(`Expected <eventSeq>:<consumer>, got ${arg}`);
        process.exit(1);
      }

      targets.push({ eventSeq, consumer: arg.slice(separator + 1) });
    }

    const redriven = await redriveDeliveries(db, targets);
    logger.info(
      `Redrove ${redriven} of ${targets.length} deliveries; restart the app to replay them`,
    );
  }
}
