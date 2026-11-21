import { afterEach, describe, expect, mock, test } from "bun:test";
import { testEventRequester } from "../../../events/test-utils";
import { ListsService } from "../../../lists";
import { DefaultConfigRecord, EConfigKey } from "../../../settings/schema";
import { listLists } from ".";

const context = {
  conversationKey: "discord:1",
  ownerKey: "discord:1",
  settings: { ...DefaultConfigRecord, [EConfigKey.AiInstructionsTimezone]: "Europe/Warsaw" },
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: testEventRequester,
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
};

afterEach(() => {
  (ListsService as unknown as { _instance: unknown })._instance = undefined;
});

describe("list-lists", () => {
  test("returns every list with local end times and expired and all-done flags", async () => {
    const list = mock(async (_ownerKey: string) => [
      {
        id: "l1",
        name: "Zakupy",
        expiresAt: Date.parse("2020-07-13T18:00:00Z"),
        createdAt: 1,
        updatedAt: 1,
        items: [
          { id: "i1", text: "mleko", done: true, position: 0 },
          { id: "i2", text: "chleb", done: true, position: 1 },
        ],
      },
      {
        id: "l2",
        name: "Pakowanie",
        expiresAt: Date.parse("2099-01-10T19:00:00Z"),
        createdAt: 2,
        updatedAt: 2,
        items: [{ id: "i3", text: "paszport", done: false, position: 0 }],
      },
      { id: "l3", name: "Sprawy", expiresAt: null, createdAt: 3, updatedAt: 3, items: [] },
    ]);
    (ListsService as unknown as { _instance: unknown })._instance = { list };

    const result = await listLists.createAgentTool(context).execute("call", {});

    expect(list).toHaveBeenCalledWith("discord:1");
    expect(result?.details).toEqual({
      timezone: "Europe/Warsaw",
      lists: [
        {
          id: "l1",
          name: "Zakupy",
          endsAt: "2020-07-13T20:00:00",
          expired: true,
          allDone: true,
          items: [
            { id: "i1", text: "mleko", done: true, position: 0 },
            { id: "i2", text: "chleb", done: true, position: 1 },
          ],
        },
        {
          id: "l2",
          name: "Pakowanie",
          endsAt: "2099-01-10T20:00:00",
          expired: false,
          allDone: false,
          items: [{ id: "i3", text: "paszport", done: false, position: 0 }],
        },
        { id: "l3", name: "Sprawy", endsAt: null, expired: false, allDone: false, items: [] },
      ],
    });
  });

  test("requires a chat owner", async () => {
    await expect(
      listLists.createAgentTool({ ...context, ownerKey: undefined }).execute("call", {}),
    ).rejects.toThrow("This tool requires a chat owner");
  });
});
