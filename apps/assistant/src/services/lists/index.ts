import { EEventType, findLists, listItemsTable, listLists, listsTable } from "@bellaclaw/database";
import {
  ITEM_NOT_FOUND,
  LIST_NOT_FOUND,
  type TListOperation,
  type TListSnapshot,
} from "@bellaclaw/shared";
import { and, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { DatabaseConnector, type TDatabaseTransaction } from "../database";
import { commandFailed, ESubscriptionMode, EventBus } from "../events";
import { ERejectionCode } from "../events/catalog";
import { EIdentityLinkOwner } from "../identity/schema";

// an operation that names a list or an item the owner does not hold; it rolls the batch back
class ListsRejection extends Error {
  public constructor(
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

type TApplied = { touchedListIds: Set<string>; deletedListIds: Set<string> };

export class ListsService {
  private static _instance: ListsService;

  private constructor() {}

  public static get instance() {
    if (!ListsService._instance) {
      ListsService._instance = new ListsService();
    }

    return ListsService._instance;
  }

  public setup(): void {
    EventBus.instance.subscribe({
      consumer: "lists",
      type: EEventType.ListsUpdateRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { ownerKey, operations } = event.payload;

        try {
          await ctx.complete(async (tx, emit) => {
            const applied = await this.apply(tx, ownerKey, operations);
            const lists = await findLists(tx, ownerKey, [...applied.touchedListIds]);
            emit(
              EEventType.ListsChanged,
              { ownerKey, lists, deletedListIds: [...applied.deletedListIds] },
              undefined,
              undefined,
            );
          });
        } catch (error) {
          await ctx.complete(async (_tx, emit) => {
            if (error instanceof ListsRejection) {
              emit(
                EEventType.CommandRejected,
                {
                  commandType: event.type,
                  code: ERejectionCode.Invalid,
                  message: error.message,
                  errorCode: error.errorCode,
                },
                undefined,
                undefined,
              );
              return;
            }

            emit(
              EEventType.CommandRejected,
              commandFailed(event.type, error),
              undefined,
              undefined,
            );
          });
        }
      },
    });
    // NOTE: every list of the address goes to the account with its ids; two lists may share a name
    EventBus.instance.subscribe({
      consumer: "lists",
      type: EEventType.IdentityLinkQuiet,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000],
      handler: async (event, ctx) => {
        const { chatKey, ownerKey } = event.payload;

        await ctx.complete(async (tx, emit) => {
          const moving = await tx
            .select({ id: listsTable.id })
            .from(listsTable)
            .where(eq(listsTable.ownerKey, chatKey));
          await tx.update(listsTable).set({ ownerKey }).where(eq(listsTable.ownerKey, chatKey));
          emit(
            EEventType.IdentityLinkMoved,
            { ...event.payload, owner: EIdentityLinkOwner.Lists },
            undefined,
            undefined,
          );

          if (moving.length > 0) {
            const lists = await findLists(
              tx,
              ownerKey,
              moving.map((list) => list.id),
            );
            emit(
              EEventType.ListsChanged,
              { ownerKey, lists, deletedListIds: [] },
              undefined,
              undefined,
            );
          }
        });
      },
    });
  }

  public async list(ownerKey: string): Promise<TListSnapshot[]> {
    return DatabaseConnector.instance.run((db) => listLists(db, ownerKey));
  }

  // applies the operations in order; throws ListsRejection at the first one naming a list or item
  // the owner does not hold. Positions stay dense from 0
  private async apply(
    tx: TDatabaseTransaction,
    ownerKey: string,
    operations: TListOperation[],
  ): Promise<TApplied> {
    const now = new Date();
    const applied: TApplied = { touchedListIds: new Set(), deletedListIds: new Set() };
    const touch = async (listId: string) => {
      await tx.update(listsTable).set({ updatedAt: now }).where(eq(listsTable.id, listId));
      applied.touchedListIds.add(listId);
    };

    for (const operation of operations) {
      if (operation.op === "create_list") {
        const listId = Bun.randomUUIDv7();
        let expiresAt: Date | null = null;

        if (operation.expiresAt !== undefined && operation.expiresAt !== null) {
          expiresAt = new Date(operation.expiresAt);
        }

        await tx.insert(listsTable).values({
          id: listId,
          ownerKey,
          name: operation.name,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        });
        await this.insertItems(tx, listId, operation.items ?? [], 0, now);
        applied.touchedListIds.add(listId);
      } else if (operation.op === "rename_list") {
        await this.ownedList(tx, ownerKey, operation.listId);
        await tx
          .update(listsTable)
          .set({ name: operation.name })
          .where(eq(listsTable.id, operation.listId));
        await touch(operation.listId);
      } else if (operation.op === "set_expiry") {
        await this.ownedList(tx, ownerKey, operation.listId);
        let expiresAt: Date | null = null;

        if (operation.expiresAt !== null) {
          expiresAt = new Date(operation.expiresAt);
        }

        await tx.update(listsTable).set({ expiresAt }).where(eq(listsTable.id, operation.listId));
        await touch(operation.listId);
      } else if (operation.op === "delete_list") {
        await this.ownedList(tx, ownerKey, operation.listId);
        await tx.delete(listItemsTable).where(eq(listItemsTable.listId, operation.listId));
        await tx.delete(listsTable).where(eq(listsTable.id, operation.listId));
        applied.touchedListIds.delete(operation.listId);
        applied.deletedListIds.add(operation.listId);
      } else if (operation.op === "add_items") {
        await this.ownedList(tx, ownerKey, operation.listId);
        const count = await tx.$count(listItemsTable, eq(listItemsTable.listId, operation.listId));
        let index = count;

        if (operation.index !== undefined && operation.index < count) {
          index = operation.index;
        }

        await tx
          .update(listItemsTable)
          .set({ position: sql`${listItemsTable.position} + ${operation.items.length}` })
          .where(
            and(eq(listItemsTable.listId, operation.listId), gte(listItemsTable.position, index)),
          );
        await this.insertItems(tx, operation.listId, operation.items, index, now);
        await touch(operation.listId);
      } else if (operation.op === "update_item") {
        const item = await this.ownedItem(tx, ownerKey, operation.itemId);
        await tx
          .update(listItemsTable)
          .set({ text: operation.text, done: operation.done, updatedAt: now })
          .where(eq(listItemsTable.id, operation.itemId));
        await touch(item.listId);
      } else if (operation.op === "move_item") {
        const item = await this.ownedItem(tx, ownerKey, operation.itemId);
        const count = await tx.$count(listItemsTable, eq(listItemsTable.listId, item.listId));
        let toIndex = count - 1;

        if (operation.toIndex < toIndex) {
          toIndex = operation.toIndex;
        }

        if (toIndex > item.position) {
          await tx
            .update(listItemsTable)
            .set({ position: sql`${listItemsTable.position} - 1` })
            .where(
              and(
                eq(listItemsTable.listId, item.listId),
                gt(listItemsTable.position, item.position),
                lte(listItemsTable.position, toIndex),
              ),
            );
        } else if (toIndex < item.position) {
          await tx
            .update(listItemsTable)
            .set({ position: sql`${listItemsTable.position} + 1` })
            .where(
              and(
                eq(listItemsTable.listId, item.listId),
                gte(listItemsTable.position, toIndex),
                lt(listItemsTable.position, item.position),
              ),
            );
        }

        await tx
          .update(listItemsTable)
          .set({ position: toIndex })
          .where(eq(listItemsTable.id, operation.itemId));
        await touch(item.listId);
      } else {
        const item = await this.ownedItem(tx, ownerKey, operation.itemId);
        await tx.delete(listItemsTable).where(eq(listItemsTable.id, operation.itemId));
        await tx
          .update(listItemsTable)
          .set({ position: sql`${listItemsTable.position} - 1` })
          .where(
            and(eq(listItemsTable.listId, item.listId), gt(listItemsTable.position, item.position)),
          );
        await touch(item.listId);
      }
    }

    return applied;
  }

  // texts: inserted in order from position index on; the caller has made room
  private async insertItems(
    tx: TDatabaseTransaction,
    listId: string,
    texts: string[],
    index: number,
    now: Date,
  ): Promise<void> {
    if (texts.length === 0) {
      return;
    }

    await tx.insert(listItemsTable).values(
      texts.map((text, offset) => ({
        id: Bun.randomUUIDv7(),
        listId,
        text,
        done: false,
        position: index + offset,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  private async ownedList(tx: TDatabaseTransaction, ownerKey: string, listId: string) {
    const row = await tx
      .select({ id: listsTable.id })
      .from(listsTable)
      .where(and(eq(listsTable.id, listId), eq(listsTable.ownerKey, ownerKey)))
      .get();

    if (row === undefined) {
      throw new ListsRejection(LIST_NOT_FOUND, `No list ${listId}`);
    }
  }

  private async ownedItem(tx: TDatabaseTransaction, ownerKey: string, itemId: string) {
    const row = await tx
      .select({ listId: listItemsTable.listId, position: listItemsTable.position })
      .from(listItemsTable)
      .innerJoin(listsTable, eq(listsTable.id, listItemsTable.listId))
      .where(and(eq(listItemsTable.id, itemId), eq(listsTable.ownerKey, ownerKey)))
      .get();

    if (row === undefined) {
      throw new ListsRejection(ITEM_NOT_FOUND, `No item ${itemId}`);
    }

    return row;
  }
}
