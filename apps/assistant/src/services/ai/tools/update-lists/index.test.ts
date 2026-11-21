import { describe, expect, mock, test } from "bun:test";
import { EEventType } from "@bellaclaw/database";
import { ITEM_NOT_FOUND } from "@bellaclaw/shared";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { CommandRejectedError, type TEventRequester } from "../../../events";
import { ERejectionCode } from "../../../events/catalog";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord, EConfigKey } from "../../../settings/schema";
import { SUpdateListsArgs, updateLists } from ".";

function execute(request: ReturnType<typeof mock>, args: unknown) {
  return updateLists
    .createAgentTool({
      conversationKey: "discord:1",
      ownerKey: "discord:1",
      settings: { ...DefaultConfigRecord, [EConfigKey.AiInstructionsTimezone]: "Europe/Warsaw" },
      trace: { turnId: "test", chatId: undefined, platform: undefined },
      events: { ...testEventRequester, request: request as unknown as TEventRequester["request"] },
      verifySettings: mock(async () => undefined),
      runScheduledTask: mock(async () => {
        throw new Error("not used");
      }),
    })
    .execute("call", args);
}

describe("SUpdateListsArgs", () => {
  test("rejects an end time with an offset", () => {
    const validator = compile(SUpdateListsArgs, { formats });

    expect(
      validator.check({
        operations: [{ op: "create_list", name: "Zakupy", endsAt: "2099-07-13T20:00:00Z" }],
      }),
    ).toBe(false);
  });
});

describe("update-lists", () => {
  test("requests the operations with local end times as epoch ms and returns the changed lists", async () => {
    const request = mock(async () => ({
      payload: {
        ownerKey: "discord:1",
        lists: [
          {
            id: "l9",
            name: "Zakupy",
            expiresAt: Date.parse("2099-07-13T18:00:00Z"),
            createdAt: 1,
            updatedAt: 1,
            items: [{ id: "i9", text: "mleko", done: false, position: 0 }],
          },
        ],
        deletedListIds: ["l2"],
      },
    }));

    const result = await execute(request, {
      operations: [
        { op: "create_list", name: "Zakupy", items: ["mleko"], endsAt: "2099-07-13T20:00" },
        { op: "set_expiry", listId: "l1", endsAt: null },
        { op: "update_item", itemId: "i1", done: true },
        { op: "delete_list", listId: "l2" },
      ],
    });

    expect(request).toHaveBeenCalledWith(
      EEventType.ListsUpdateRequested,
      {
        ownerKey: "discord:1",
        operations: [
          {
            op: "create_list",
            name: "Zakupy",
            items: ["mleko"],
            expiresAt: Date.parse("2099-07-13T18:00:00Z"),
          },
          { op: "set_expiry", listId: "l1", expiresAt: null },
          { op: "update_item", itemId: "i1", done: true },
          { op: "delete_list", listId: "l2" },
        ],
      },
      expect.objectContaining({ outcome: EEventType.ListsChanged, key: "discord:1" }),
    );
    expect(result?.details).toEqual({
      timezone: "Europe/Warsaw",
      lists: [
        {
          id: "l9",
          name: "Zakupy",
          endsAt: "2099-07-13T20:00:00",
          expired: false,
          allDone: false,
          items: [{ id: "i9", text: "mleko", done: false, position: 0 }],
        },
      ],
      deletedListIds: ["l2"],
    });
  });

  test("turns a missing item into a clear error", async () => {
    const request = mock(async () => {
      throw new CommandRejectedError(ERejectionCode.Invalid, "No item i1", ITEM_NOT_FOUND);
    });

    const result = await execute(request, {
      operations: [{ op: "update_item", itemId: "i1", done: true }],
    });

    expect(result).toMatchObject({
      isError: true,
      details: { errorCode: ITEM_NOT_FOUND },
      content: [
        {
          type: "text",
          text: "No item i1. Nothing was changed; call list-lists for the current ids",
        },
      ],
    });
  });

  test("rejects an update_item with nothing to change before requesting", async () => {
    const request = mock(async () => ({}));

    const result = await execute(request, { operations: [{ op: "update_item", itemId: "i1" }] });

    expect(result).toMatchObject({ isError: true, details: { errorCode: "invalid-operation" } });
    expect(request).not.toHaveBeenCalled();
  });
});
