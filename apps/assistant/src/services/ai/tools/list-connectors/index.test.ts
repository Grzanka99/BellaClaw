import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorsTable, EConnectorKind, EConnectorStatus } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { DatabaseConnector } from "../../../database";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { listConnectors } from ".";

const OWNER = "account:owner";

let directory: string;
let previousConfig: TOption<string>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-list-connectors-"));
  previousConfig = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  Bun.env.BELLACLAW_CONNECTORS_CONFIG = join(directory, "connectors.json");
  await DatabaseConnector.instance.database.delete(connectorsTable);
});

afterEach(async () => {
  await DatabaseConnector.instance.database.delete(connectorsTable);
  if (previousConfig === undefined) {
    delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  } else {
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = previousConfig;
  }
  await rm(directory, { recursive: true, force: true });
});

describe("list-connectors", () => {
  test("lists the server-wide connectors and the owner's own in every status", async () => {
    await Bun.write(
      join(directory, "connectors.json"),
      JSON.stringify({
        connectors: [
          {
            id: "files",
            description: "File tools",
            instructions: "Use the file tools",
            transport: { type: "stdio", command: "unused" },
          },
        ],
      }),
    );
    const rows = [
      ["notes", OWNER, EConnectorStatus.Active, 1],
      ["github", OWNER, EConnectorStatus.PendingAdd, 2],
      ["old", OWNER, EConnectorStatus.PendingRemoval, 3],
      ["theirs", "account:other", EConnectorStatus.Active, 4],
    ] as const;
    await DatabaseConnector.instance.database.insert(connectorsTable).values(
      rows.map(([id, ownerKey, status, at]) => ({
        ownerKey,
        id,
        kind: EConnectorKind.Mcp,
        url: `https://${id}.example.com/mcp`,
        description: `${id} tools`,
        plainChats: id === "notes",
        status,
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })),
    );

    const result = await listConnectors
      .createAgentTool({
        conversationKey: "discord:1",
        ownerKey: OWNER,
        settings: DefaultConfigRecord,
        trace: { turnId: "test", chatId: undefined, platform: undefined },
        events: testEventRequester,
        verifySettings: mock(async () => undefined),
        runScheduledTask: mock(async () => {
          throw new Error("not used");
        }),
      })
      .execute("call", {});

    expect(result?.details).toEqual({
      serverConnectors: [
        { id: "files", description: "File tools", serverWide: true, readOnly: true },
      ],
      userConnectors: [
        {
          id: "notes",
          kind: EConnectorKind.Mcp,
          url: "https://notes.example.com/mcp",
          description: "notes tools",
          plainChats: true,
          status: EConnectorStatus.Active,
        },
        {
          id: "github",
          kind: EConnectorKind.Mcp,
          url: "https://github.example.com/mcp",
          description: "github tools",
          plainChats: false,
          status: EConnectorStatus.PendingAdd,
        },
        {
          id: "old",
          kind: EConnectorKind.Mcp,
          url: "https://old.example.com/mcp",
          description: "old tools",
          plainChats: false,
          status: EConnectorStatus.PendingRemoval,
        },
      ],
    });
  });
});
