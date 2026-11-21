import type { TListSnapshot, TOption } from "@bellaclaw/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { listItemsTable, listsTable } from "./schema";

// the assistant's handle or transaction, or the gateway's read-only connection
type TReadHandle = Pick<BaseSQLiteDatabase<"async", unknown>, "select">;

// The owner's lists, oldest first, each with its items in order
export async function listLists(db: TReadHandle, ownerKey: string): Promise<TListSnapshot[]> {
  return findLists(db, ownerKey, undefined);
}

// The owner's lists of the ids, or all its lists without ids, oldest first. A list of another
// owner is left out
export async function findLists(
  db: TReadHandle,
  ownerKey: string,
  listIds: TOption<string[]>,
): Promise<TListSnapshot[]> {
  const conditions = [eq(listsTable.ownerKey, ownerKey)];

  if (listIds !== undefined) {
    conditions.push(inArray(listsTable.id, listIds));
  }

  const lists = await db
    .select()
    .from(listsTable)
    .where(and(...conditions))
    .orderBy(asc(listsTable.createdAt), asc(listsTable.id));

  if (lists.length === 0) {
    return [];
  }

  const items = await db
    .select()
    .from(listItemsTable)
    .where(
      inArray(
        listItemsTable.listId,
        lists.map((list) => list.id),
      ),
    )
    .orderBy(asc(listItemsTable.position));

  return lists.map((list) => ({
    id: list.id,
    name: list.name,
    expiresAt: list.expiresAt?.getTime() ?? null,
    createdAt: list.createdAt.getTime(),
    updatedAt: list.updatedAt.getTime(),
    items: items
      .filter((item) => item.listId === list.id)
      .map((item) => ({ id: item.id, text: item.text, done: item.done, position: item.position })),
  }));
}
