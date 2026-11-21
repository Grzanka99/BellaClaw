import { EEventType } from "@bellaclaw/database";
import {
  ITEM_NOT_FOUND,
  LIST_NOT_FOUND,
  type TListOperation,
  type TOption,
} from "@bellaclaw/shared";
import { arr, bool, int, lit, nullable, obj, opt, str, union } from "@earendil-works/pi-schema";
import { CommandRejectedError } from "../../../events";
import { EConfigKey } from "../../../settings/schema";
import { LOCAL_FIRE_AT_PATTERN, parseLocalFireAt } from "../cron-content";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import { toListsResult } from "../list-content";
import instructions from "./instructions.xml" with { type: "text" };

const SListName = str({ minLength: 1, maxLength: 100, pattern: "\\S", description: "List name" });
const SItemText = str({
  minLength: 1,
  maxLength: 500,
  pattern: "\\S",
  description: "Short item text, as the user said it",
});
const SEndsAt = str({
  pattern: LOCAL_FIRE_AT_PATTERN,
  description:
    "End time as local date-time in the owner's timezone, YYYY-MM-DDTHH:mm[:ss], no offset",
});
const SListId = str({ minLength: 1, description: "List id from list-lists" });
const SItemId = str({ minLength: 1, description: "Item id from list-lists" });

export const SUpdateListsArgs = obj({
  operations: arr(
    union([
      obj({
        op: lit("create_list"),
        name: SListName,
        items: opt(arr(SItemText)),
        endsAt: opt(SEndsAt),
      }),
      obj({
        op: lit("set_expiry"),
        listId: SListId,
        endsAt: nullable(SEndsAt, { description: "New end time; null removes it" }),
      }),
      obj({ op: lit("rename_list"), listId: SListId, name: SListName }),
      obj({ op: lit("delete_list"), listId: SListId }),
      obj({
        op: lit("add_items"),
        listId: SListId,
        items: arr(SItemText, { minItems: 1 }),
        index: opt(int({ minimum: 0, description: "Insert position; omit to append" })),
      }),
      obj({
        op: lit("update_item"),
        itemId: SItemId,
        text: opt(SItemText),
        done: opt(bool({ description: "true ticks the item, false unticks it" })),
      }),
      obj({
        op: lit("move_item"),
        itemId: SItemId,
        toIndex: int({ minimum: 0, description: "New position; past the end moves it last" }),
      }),
      obj({ op: lit("delete_item"), itemId: SItemId }),
    ]),
    { minItems: 1, maxItems: 50, description: "Changes applied in order, all or none" },
  ),
});

export const updateLists = defineTool({
  name: "update-lists",
  label: "Update lists",
  description:
    "Apply changes to the user's to-do lists in order, all or none: create, rename, set or clear the end time, delete a list; add, edit, tick, move or delete items. Returns the changed lists and the ids of deleted ones.",
  schema: SUpdateListsArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  privateErrors: true,
  execute: async (context, args) => {
    const ownerKey = requireChatId(context.ownerKey);
    const timezone = context.settings[EConfigKey.AiInstructionsTimezone];
    const operations: TListOperation[] = [];

    for (const operation of args.operations) {
      if (operation.op === "create_list") {
        let expiresAt: TOption<number>;

        if (operation.endsAt !== undefined) {
          expiresAt = parseLocalFireAt(operation.endsAt, timezone).getTime();
        }

        operations.push({
          op: operation.op,
          name: operation.name,
          items: operation.items,
          expiresAt,
        });
      } else if (operation.op === "set_expiry") {
        let expiresAt: number | null = null;

        if (operation.endsAt !== null) {
          expiresAt = parseLocalFireAt(operation.endsAt, timezone).getTime();
        }

        operations.push({ op: operation.op, listId: operation.listId, expiresAt });
      } else {
        if (
          operation.op === "update_item" &&
          operation.text === undefined &&
          operation.done === undefined
        ) {
          throw new ToolError("invalid-operation", "update_item needs text or done");
        }

        operations.push(operation);
      }
    }

    try {
      const changed = await context.events.request(
        EEventType.ListsUpdateRequested,
        { ownerKey, operations },
        { outcome: EEventType.ListsChanged, step: undefined, key: ownerKey, timeoutMs: undefined },
      );

      return {
        ...toListsResult(changed.payload.lists, timezone, Date.now()),
        deletedListIds: changed.payload.deletedListIds,
      };
    } catch (error) {
      if (
        error instanceof CommandRejectedError &&
        (error.errorCode === LIST_NOT_FOUND || error.errorCode === ITEM_NOT_FOUND)
      ) {
        throw new ToolError(
          error.errorCode,
          `${error.message}. Nothing was changed; call list-lists for the current ids`,
        );
      }

      throw error;
    }
  },
});
