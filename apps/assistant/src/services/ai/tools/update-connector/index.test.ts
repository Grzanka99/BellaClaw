import { describe, expect, mock, test } from "bun:test";
import { EConnectorKind, EConnectorStatus, EEventType } from "@bellaclaw/database";
import type { TEventRequester } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { updateConnector } from ".";

function execute(request: ReturnType<typeof mock>, args: unknown) {
  return updateConnector
    .createAgentTool({
      conversationKey: "discord:1",
      ownerKey: "discord:1",
      settings: DefaultConfigRecord,
      trace: { turnId: "test", chatId: undefined, platform: undefined },
      events: { ...testEventRequester, request: request as unknown as TEventRequester["request"] },
      verifySettings: mock(async () => undefined),
      runScheduledTask: mock(async () => {
        throw new Error("not used");
      }),
    })
    .execute("call", args);
}

describe("update-connector", () => {
  test("requests the change and returns the connector after it", async () => {
    const request = mock(async () => ({
      payload: {
        ownerKey: "discord:1",
        connectorId: "notes",
        connector: {
          kind: EConnectorKind.Mcp,
          url: "https://notes.example.com/mcp",
          description: "Personal notes",
          plainChats: true,
          status: EConnectorStatus.Active,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    }));

    const result = await execute(request, { id: "notes", plainChats: true });

    expect(request).toHaveBeenCalledWith(
      EEventType.ConnectorUpdateRequested,
      { ownerKey: "discord:1", id: "notes", description: undefined, plainChats: true },
      expect.objectContaining({ outcome: EEventType.ConnectorsChanged, key: "discord:1" }),
    );
    expect(result?.details).toEqual({
      id: "notes",
      description: "Personal notes",
      plainChats: true,
      status: EConnectorStatus.Active,
    });
  });

  test("refuses an update without a description or plainChats", async () => {
    const request = mock(async () => {
      throw new Error("not used");
    });

    const result = await execute(request, { id: "notes" });

    expect(result).toMatchObject({
      isError: true,
      details: { errorCode: "invalid-update" },
      content: [
        { type: "text", text: "Give a new description or plainChats; nothing was changed" },
      ],
    });
    expect(request).not.toHaveBeenCalled();
  });

  test("refuses a description with a line break", async () => {
    const request = mock(async () => {
      throw new Error("not used");
    });

    await expect(execute(request, { id: "notes", description: "Notes\nmore" })).rejects.toThrow(
      "Invalid tool arguments",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
