import { z } from "zod";

// the rejection codes of a list change naming a list or an item the owner does not hold
export const LIST_NOT_FOUND = "list-not-found";
export const ITEM_NOT_FOUND = "item-not-found";

const SListName = z.string().trim().min(1).max(100);
const SItemText = z.string().trim().min(1).max(500);

// epoch ms; null: none
const SExpiresAt = z.number().int().nullable();

// one change of the owner's lists. expiresAt: the list's end time; index: where add_items inserts, the end without one; toIndex:
// past the end moves the item to the end
export const SListOperation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("create_list"),
      name: SListName,
      items: z.array(SItemText).optional(),
      expiresAt: SExpiresAt.optional(),
    })
    .strict(),
  z.object({ op: z.literal("set_expiry"), listId: z.string(), expiresAt: SExpiresAt }).strict(),
  z.object({ op: z.literal("rename_list"), listId: z.string(), name: SListName }).strict(),
  z.object({ op: z.literal("delete_list"), listId: z.string() }).strict(),
  z
    .object({
      op: z.literal("add_items"),
      listId: z.string(),
      items: z.array(SItemText).min(1),
      index: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("update_item"),
      itemId: z.string(),
      text: SItemText.optional(),
      done: z.boolean().optional(),
    })
    .strict()
    .refine((operation) => operation.text !== undefined || operation.done !== undefined, {
      message: "update_item needs text or done",
    }),
  z
    .object({ op: z.literal("move_item"), itemId: z.string(), toIndex: z.number().int().min(0) })
    .strict(),
  z.object({ op: z.literal("delete_item"), itemId: z.string() }).strict(),
]);

export type TListOperation = z.infer<typeof SListOperation>;

// a list as Lists stores it; dates as epoch ms, items by position
export const SListSnapshot = z
  .object({
    id: z.string(),
    name: z.string(),
    expiresAt: SExpiresAt,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    items: z.array(
      z
        .object({ id: z.string(), text: z.string(), done: z.boolean(), position: z.number().int() })
        .strict(),
    ),
  })
  .strict();

export type TListSnapshot = z.infer<typeof SListSnapshot>;

// a batch of list changes, applied in order, all or none
export const SListOperations = z.array(SListOperation).min(1).max(50);

// POST /internal/accounts/:accountId/lists body, and POST /api/lists/changes of the edge: the
// account's list changes, applied in order, all or none
export const SGatewayListsUpdate = z.object({ operations: SListOperations }).strict();

export type TGatewayListsUpdate = z.infer<typeof SGatewayListsUpdate>;

// POST /internal/accounts/:accountId/lists response: the lists the change touched, after it,
// expired ones included, and the ids of the deleted ones
export const SGatewayListsChanged = z.object({
  lists: z.array(SListSnapshot),
  deletedListIds: z.array(z.string()),
});

export type TGatewayListsChanged = z.infer<typeof SGatewayListsChanged>;
