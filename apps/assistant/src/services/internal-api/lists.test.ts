import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  EEventType,
  eventsTable,
  listItemsTable,
  listLists,
  listsTable,
} from "@bellaclaw/database";
import { gatewayAccountListsPath, LIST_NOT_FOUND } from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { EventBus } from "../events";
import { IdentityService } from "../identity";
import { ListsService } from "../lists";
import { setupInternalApi } from ".";
import { internalRequest, resetServices } from "./test-utils";

const ACCOUNT_ID = "acct-lists";
const OWNER_KEY = `account:${ACCOUNT_ID}`;

resetServices([EventBus, IdentityService, ListsService]);

async function clearLists() {
  const db = DatabaseConnector.instance.database;
  await db.delete(listItemsTable);
  await db.delete(listsTable);
}

beforeEach(async () => {
  await clearLists();
  setupInternalApi();
  ListsService.instance.setup();
  await IdentityService.instance.setup();
  await EventBus.instance.start();
});

afterEach(clearLists);

async function change(body: unknown): Promise<[number, unknown]> {
  const response = await internalRequest(
    "POST",
    gatewayAccountListsPath(ACCOUNT_ID),
    JSON.stringify(body),
  );
  const answer: [number, unknown] = [response.status, await response.json()];
  await EventBus.instance.idle();
  return answer;
}

test("the app's list changes apply on the account's lane and answer the touched lists", async () => {
  const [status, body] = await change({
    operations: [{ op: "create_list", name: "Shopping", items: ["milk", "eggs"] }],
  });

  expect(status).toBe(200);
  const stored = await listLists(DatabaseConnector.instance.database, OWNER_KEY);
  expect(body).toEqual({ lists: stored, deletedListIds: [] });
  expect(stored).toMatchObject([
    {
      name: "Shopping",
      expiresAt: null,
      items: [
        { text: "milk", done: false, position: 0 },
        { text: "eggs", done: false, position: 1 },
      ],
    },
  ]);
  const requested = await DatabaseConnector.instance.database
    .select({ key: eventsTable.key })
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.ListsUpdateRequested));
  expect(requested).toEqual([{ key: OWNER_KEY }]);

  const listId = stored[0]?.id ?? "";
  const itemId = stored[0]?.items[0]?.id ?? "";
  expect(
    await change({
      operations: [
        { op: "update_item", itemId, done: true },
        { op: "rename_list", listId, name: "Groceries" },
      ],
    }),
  ).toEqual([
    200,
    { lists: [expect.objectContaining({ id: listId, name: "Groceries" })], deletedListIds: [] },
  ]);
  expect(await change({ operations: [{ op: "delete_list", listId }] })).toEqual([
    200,
    { lists: [], deletedListIds: [listId] },
  ]);
});

test("a change naming a list the account does not hold answers 404 with its code and changes nothing", async () => {
  await change({ operations: [{ op: "create_list", name: "Shopping" }] });

  const [status, body] = await change({
    operations: [
      { op: "create_list", name: "Trip" },
      { op: "add_items", listId: "missing", items: ["milk"] },
    ],
  });

  expect(status).toBe(404);
  expect(body).toEqual({ error: expect.any(String), code: LIST_NOT_FOUND });
  expect(
    (await listLists(DatabaseConnector.instance.database, OWNER_KEY)).map((list) => list.name),
  ).toEqual(["Shopping"]);
});

test("an invalid change answers 400 and requests nothing", async () => {
  for (const body of [
    { operations: [] },
    { operations: [{ op: "create_list", name: " " }] },
    { operations: [{ op: "update_item", itemId: "item" }] },
    { ownerKey: "account:other", operations: [{ op: "create_list", name: "Trip" }] },
  ]) {
    expect((await change(body))[0]).toBe(400);
  }

  const requested = await DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.ListsUpdateRequested));
  expect(requested).toEqual([]);
});
