import { describe, expect, mock, test } from "bun:test";
import { EConnectorKind, EConnectorStatus, EEventType } from "@bellaclaw/database";
import type { TEventRequester } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { removeConnector } from ".";

function execute(request: ReturnType<typeof mock>) {
  return removeConnector
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
    .execute("call", { id: "notes" });
}

describe("remove-connector", () => {
  test("reports a connector that was only pending as gone", async () => {
    const request = mock(async () => ({
      payload: { ownerKey: "discord:1", connectorId: "notes", connector: null },
    }));

    const result = await execute(request);

    expect(request).toHaveBeenCalledWith(
      EEventType.ConnectorRemoveRequested,
      { ownerKey: "discord:1", id: "notes" },
      expect.objectContaining({ outcome: EEventType.ConnectorsChanged, key: "discord:1" }),
    );
    expect(result?.details).toEqual({ id: "notes", status: "removed" });
  });

  test("reports an active connector as pending removal with the approval command", async () => {
    const request = mock(async () => ({
      payload: {
        ownerKey: "discord:1",
        connectorId: "notes",
        connector: {
          kind: EConnectorKind.Mcp,
          url: "https://notes.example.com/mcp",
          description: "Personal notes",
          plainChats: false,
          status: EConnectorStatus.PendingRemoval,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    }));

    const result = await execute(request);

    expect(result?.details).toEqual({
      id: "notes",
      status: EConnectorStatus.PendingRemoval,
      approvalCommand: "!connector approve notes",
      rejectCommand: "!connector reject notes",
    });
  });
});
