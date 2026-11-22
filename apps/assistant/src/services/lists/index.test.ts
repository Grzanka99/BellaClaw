import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EEventType,
  eventDeliveriesTable,
  eventsTable,
  listItemsTable,
  listsTable,
} from "@bellaclaw/database";
import {
  ITEM_NOT_FOUND,
  LIST_NOT_FOUND,
  type TListOperation,
  type TListSnapshot,
} from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { ERejectionCode } from "../events/catalog";
import { withEventContext } from "../events/test-utils";
import { EIdentityLinkOwner } from "../identity/schema";
import { EMessagePlatform } from "../messaging/types";
import { ListsService } from ".";

const OWNER = "account:owner";

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(ListsService, { _instance: undefined });
}

async function clearLists() {
  const db = DatabaseConnector.instance.database;
  await db.delete(listItemsTable);
  await db.delete(listsTable);
}

// the tools' path: request lists.update.requested on the owner's lane and return the outcome
async function update(operations: TListOperation[], ownerKey = OWNER) {
  const changed = await withEventContext((ctx) =>
    ctx.request(
      EEventType.ListsUpdateRequested,
      { ownerKey, operations },
      { outcome: EEventType.ListsChanged, step: undefined, key: ownerKey, timeoutMs: undefined },
    ),
  );
  await EventBus.instance.idle();
  return changed.payload;
}

function texts(list: TListSnapshot | undefined) {
  return list?.items.map((item) => [item.text, item.position]);
}

async function createShopping() {
  const changed = await update([
    { op: "create_list", name: " Shopping ", items: ["milk", "eggs", "bread"] },
  ]);
  const list = changed.lists[0];

  if (list === undefined) {
    throw new Error("no list created");
  }

  return list;
}

beforeEach(async () => {
  reset();
  await resetEventTables();
  await clearLists();
  ListsService.instance.setup();
  await EventBus.instance.start();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await clearLists();
  reset();
});

describe("ListsService", () => {
  test("creates a list with items, and the rows and the ack commit together", async () => {
    const list = await createShopping();

    expect(list.name).toBe("Shopping");
    expect(texts(list)).toEqual([
      ["milk", 0],
      ["eggs", 1],
      ["bread", 2],
    ]);
    expect(await ListsService.instance.list(OWNER)).toEqual([list]);
    expect(await ListsService.instance.list("account:other")).toEqual([]);

    const deliveries = await DatabaseConnector.instance.database
      .select({ status: eventDeliveriesTable.status })
      .from(eventDeliveriesTable)
      .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
      .where(eq(eventsTable.type, EEventType.ListsUpdateRequested));
    expect(deliveries).toEqual([{ status: "done" }]);
  });

  test("adds items at the end and at an index", async () => {
    const list = await createShopping();

    await update([{ op: "add_items", listId: list.id, items: ["butter"] }]);
    const changed = await update([
      { op: "add_items", listId: list.id, items: ["apples", "pears"], index: 1 },
    ]);

    expect(texts(changed.lists[0])).toEqual([
      ["milk", 0],
      ["apples", 1],
      ["pears", 2],
      ["eggs", 3],
      ["bread", 4],
      ["butter", 5],
    ]);
  });

  test("ticks, unticks and renames an item, and bumps the list", async () => {
    const list = await createShopping();
    const eggs = list.items[1]?.id ?? "";

    let changed = await update([{ op: "update_item", itemId: eggs, done: true }]);
    expect(changed.lists[0]?.items[1]).toMatchObject({ text: "eggs", done: true });
    expect(changed.lists[0]?.updatedAt).toBeGreaterThanOrEqual(list.updatedAt);

    changed = await update([
      { op: "update_item", itemId: eggs, done: false },
      { op: "update_item", itemId: eggs, text: "12 eggs" },
    ]);
    expect(changed.lists[0]?.items[1]).toMatchObject({ text: "12 eggs", done: false });
  });

  test("a list finishes once: ticking its last open item emits list.finished, unticking and ticking again does not", async () => {
    const list = await createShopping();
    const [milk, eggs, bread] = list.items.map((item) => item.id);
    const finished = async () =>
      (
        await DatabaseConnector.instance.database
          .select()
          .from(eventsTable)
          .where(eq(eventsTable.type, EEventType.ListFinished))
      ).map((event) => event.payload);

    await update([
      { op: "update_item", itemId: milk ?? "", done: true },
      { op: "update_item", itemId: eggs ?? "", done: true },
    ]);
    expect(await finished()).toEqual([]);

    await update([{ op: "update_item", itemId: bread ?? "", done: true }]);
    const [first] = await finished();
    expect(first).toEqual({
      ownerKey: OWNER,
      listId: list.id,
      name: "Shopping",
      total: 3,
      finishedAt: expect.any(Number),
    });

    await update([{ op: "update_item", itemId: bread ?? "", done: false }]);
    await update([{ op: "update_item", itemId: bread ?? "", done: true }]);
    expect(await finished()).toHaveLength(1);
  });

  test("moves an item down and up, keeping positions dense", async () => {
    const list = await createShopping();
    const milk = list.items[0]?.id ?? "";
    const bread = list.items[2]?.id ?? "";

    let changed = await update([{ op: "move_item", itemId: milk, toIndex: 99 }]);
    expect(texts(changed.lists[0])).toEqual([
      ["eggs", 0],
      ["bread", 1],
      ["milk", 2],
    ]);

    changed = await update([{ op: "move_item", itemId: bread, toIndex: 0 }]);
    expect(texts(changed.lists[0])).toEqual([
      ["bread", 0],
      ["eggs", 1],
      ["milk", 2],
    ]);
  });

  test("deletes an item, keeping positions dense", async () => {
    const list = await createShopping();

    const changed = await update([{ op: "delete_item", itemId: list.items[0]?.id ?? "" }]);

    expect(texts(changed.lists[0])).toEqual([
      ["eggs", 0],
      ["bread", 1],
    ]);
  });

  test("renames and deletes a list with its items", async () => {
    const list = await createShopping();

    const renamed = await update([{ op: "rename_list", listId: list.id, name: "Groceries" }]);
    expect(renamed.lists[0]?.name).toBe("Groceries");

    const deleted = await update([{ op: "delete_list", listId: list.id }]);
    expect(deleted).toEqual({ ownerKey: OWNER, lists: [], deletedListIds: [list.id] });
    expect(await ListsService.instance.list(OWNER)).toEqual([]);
    expect(await DatabaseConnector.instance.database.select().from(listItemsTable)).toEqual([]);
  });

  test("creates a list with an end time, then sets and clears it", async () => {
    const created = await update([{ op: "create_list", name: "Trip", expiresAt: 1_000 }]);
    const list = created.lists[0];
    expect(list?.expiresAt).toBe(1_000);

    const set = await update([{ op: "set_expiry", listId: list?.id ?? "", expiresAt: 2_000 }]);
    expect(set.lists[0]?.expiresAt).toBe(2_000);

    const cleared = await update([{ op: "set_expiry", listId: list?.id ?? "", expiresAt: null }]);
    expect(cleared.lists[0]?.expiresAt).toBeNull();
    expect(await ListsService.instance.list(OWNER)).toEqual(cleared.lists);
  });

  test("rejects another owner's list and item, and writes nothing of the batch", async () => {
    const foreign = await update([{ op: "create_list", name: "Theirs", items: ["x"] }], "other");
    const foreignList = foreign.lists[0];
    const before = await ListsService.instance.list(OWNER);

    const listRejected = update([
      { op: "create_list", name: "Mine" },
      { op: "rename_list", listId: foreignList?.id ?? "", name: "Stolen" },
    ]);
    await expect(listRejected).rejects.toMatchObject({
      code: ERejectionCode.Invalid,
      errorCode: LIST_NOT_FOUND,
    });

    const itemRejected = update([
      { op: "update_item", itemId: foreignList?.items[0]?.id ?? "", done: true },
    ]);
    await expect(itemRejected).rejects.toMatchObject({
      code: ERejectionCode.Invalid,
      errorCode: ITEM_NOT_FOUND,
    });
    await EventBus.instance.idle();

    expect(await ListsService.instance.list(OWNER)).toEqual(before);
    expect(await ListsService.instance.list("other")).toEqual(foreign.lists);
  });

  test("on a link, moves the address's lists to the account with their items and ids, and keeps the account's own", async () => {
    const chatKey = "signal:+100";
    const own = await createShopping();
    const moving = (
      await update([{ op: "create_list", name: "Shopping", items: ["tea"] }], chatKey)
    ).lists;
    const keys = {
      accountId: "owner",
      channel: EMessagePlatform.Signal,
      address: "+100",
      chatKey,
      conversationKey: "bella:owner",
      ownerKey: OWNER,
    };

    await EventBus.instance.publish({
      type: EEventType.IdentityLinkQuiet,
      source: "test",
      key: chatKey,
      trace: { turnId: "test:link", chatId: chatKey, platform: undefined },
      payload: keys,
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();

    expect(await ListsService.instance.list(chatKey)).toEqual([]);
    expect(await ListsService.instance.list(OWNER)).toEqual([own, ...moving]);
    const db = DatabaseConnector.instance.database;
    const payloads = async (type: EEventType) =>
      (await db.select().from(eventsTable).where(eq(eventsTable.type, type))).map(
        (event) => event.payload,
      );
    expect(await payloads(EEventType.IdentityLinkMoved)).toEqual([
      { ...keys, owner: EIdentityLinkOwner.Lists },
    ]);
    expect((await payloads(EEventType.ListsChanged)).at(-1)).toEqual({
      ownerKey: OWNER,
      lists: moving,
      deletedListIds: [],
    });
  });
});
