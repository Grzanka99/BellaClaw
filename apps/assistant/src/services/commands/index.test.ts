import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EEventType, eventsTable } from "@bellaclaw/database";
import { verifyGatewayLinkToken } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import { AuthorizationService } from "../authorization";
import { DatabaseConnector } from "../database";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { testMessageOrigin, withEventContext } from "../events/test-utils";
import { EMessagePlatform, type TAttachmentRef } from "../messaging/types";
import { Commands, runCommand } from ".";

const originalConnectorsConfig = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
const signal = { channel: EMessagePlatform.Signal, address: "+100" };

async function rowsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
}

async function payloadsOf(type: EEventType) {
  return (await rowsOf(type)).map((row) => row.payload);
}

describe("commands consumer", () => {
  let bus: EventBus;
  let directory: string;

  async function authorized(
    chatId: string,
    content: string,
    receivedAt: number,
    attachments: TAttachmentRef[] = [],
  ) {
    await bus.publish({
      type: EEventType.MessageAuthorized,
      source: "test",
      key: chatId,
      trace: { turnId: "test:commands", chatId, platform: EMessagePlatform.Discord },
      payload: {
        ...testMessageOrigin(chatId, EMessagePlatform.Discord),
        content,
        attachments,
        receivedAt,
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await bus.idle();
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bellaclaw-commands-"));
    await resetEventTables();
    Object.assign(Commands, { _instance: undefined });
    Object.assign(EventBus, { _instance: undefined });
    bus = EventBus.instance;
    Commands.instance.setup();
    await bus.start();
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
    if (originalConnectorsConfig === undefined) {
      delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
    } else {
      Bun.env.BELLACLAW_CONNECTORS_CONFIG = originalConnectorsConfig;
    }
    await rm(directory, { recursive: true, force: true });
  });

  test("a plain message becomes turn.requested with the transport's arrival time", async () => {
    await authorized("discord:100", "What is on my calendar tomorrow?", 1_234);

    expect(await payloadsOf(EEventType.TurnRequested)).toEqual([
      {
        ...testMessageOrigin("discord:100", EMessagePlatform.Discord),
        content: "What is on my calendar tomorrow?",
        attachments: [],
        receivedAt: 1_234,
      },
    ]);
  });

  test("!update asks the supervisor for an update, and says so when there is none", async () => {
    const send = mock((_message: unknown) => true);
    const activated = spyOn(
      AuthorizationService.instance,
      "listAuthorizedChatIds",
    ).mockResolvedValue(["discord:100"]);

    await authorized("discord:100", "!update", 1);
    process.send = send;
    try {
      await authorized("discord:100", "!update", 2);
      await authorized("discord:999", "!update", 3);
    } finally {
      process.send = undefined;
      activated.mockRestore();
    }

    const runIds = (await rowsOf(EEventType.MessageAuthorized)).map((row) => row.id);
    // the supervisor's notices come back as later steps of the same run
    expect(send.mock.calls).toEqual([
      [{ type: "update", chatId: "discord:100", runId: runIds[1] }],
    ]);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      {
        ...testMessageOrigin("discord:100", EMessagePlatform.Discord),
        text: "Self-update is unavailable: the bot is not running under its supervisor.",
        display: {
          text: "Self-update is unavailable: the bot is not running under its supervisor.",
          request: { text: "!update", receivedAt: 1 },
          command: { runId: runIds[0], name: "update", state: "failed", outcome: "unavailable" },
        },
      },
      {
        ...testMessageOrigin("discord:100", EMessagePlatform.Discord),
        text: "Checking for an update.",
        display: {
          text: "Checking for an update.",
          request: { text: "!update", receivedAt: 2 },
          command: { runId: runIds[1], name: "update", state: "running", outcome: "checking" },
        },
      },
      {
        ...testMessageOrigin("discord:999", EMessagePlatform.Discord),
        text: "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
        display: {
          text: "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
          request: { text: "!update", receivedAt: 3 },
          command: { runId: runIds[2], name: "update", state: "failed", outcome: "not activated" },
        },
      },
    ]);
  });

  test("!update checks the activation of the conversation, not of the owner", async () => {
    const activated = spyOn(
      AuthorizationService.instance,
      "listAuthorizedChatIds",
    ).mockResolvedValue(["discord:100"]);

    try {
      expect(
        await withEventContext((ctx) =>
          runCommand(
            "discord:owner",
            { channel: EMessagePlatform.Discord, address: "100" },
            "!update",
            ctx,
            "run-1",
          ),
        ),
      ).toMatchObject({
        result: {
          text: "Self-update is unavailable: the bot is not running under its supervisor.",
        },
      });
      expect(
        await withEventContext((ctx) =>
          runCommand(
            "discord:100",
            { channel: EMessagePlatform.Discord, address: "999" },
            "!update",
            ctx,
            "run-2",
          ),
        ),
      ).toMatchObject({
        result: { text: "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat." },
      });
    } finally {
      activated.mockRestore();
    }
  });

  test("!dashboard signs the address the command came from, not the owner", async () => {
    const originalUrl = Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL;
    const originalSecret = Bun.env.BELLACLAW_GATEWAY_SECRET;
    Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = "https://dashboard.test";
    Bun.env.BELLACLAW_GATEWAY_SECRET = "gateway-secret";

    try {
      const reply = await withEventContext((ctx) =>
        runCommand("account:acct-1", signal, "!dashboard", ctx, "run-1"),
      );
      let text = "";
      if (typeof reply?.result === "object" && "confidential" in reply.result) {
        text = reply.result.confidential;
      }
      const token = text.match(/token=([^\s]+)/)?.[1] ?? "";

      expect(verifyGatewayLinkToken("gateway-secret", token, Date.now())?.chatId).toBe(
        "signal:+100",
      );
    } finally {
      Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = originalUrl;
      Bun.env.BELLACLAW_GATEWAY_SECRET = originalSecret;
    }
  });

  test("!app answers confidentially with the dashboard's app page, signed for the address", async () => {
    const originalUrl = Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL;
    const originalSecret = Bun.env.BELLACLAW_GATEWAY_SECRET;
    Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = "https://dashboard.test/";
    Bun.env.BELLACLAW_GATEWAY_SECRET = "gateway-secret";

    try {
      const reply = await withEventContext((ctx) =>
        runCommand("account:acct-1", signal, "!app", ctx, "run-1"),
      );
      let text = "";
      if (typeof reply?.result === "object" && "confidential" in reply.result) {
        text = reply.result.confidential;
      }
      const token = text.match(/^https:\/\/dashboard\.test\/app\?token=([^\s]+)\n/)?.[1] ?? "";

      expect(verifyGatewayLinkToken("gateway-secret", token, Date.now())?.chatId).toBe(
        "signal:+100",
      );

      Bun.env.BELLACLAW_GATEWAY_SECRET = "";
      expect(
        await withEventContext((ctx) => runCommand("account:acct-1", signal, "!app", ctx, "run-2")),
      ).toMatchObject({ result: { text: "The dashboard is not configured." } });
    } finally {
      Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = originalUrl;
      Bun.env.BELLACLAW_GATEWAY_SECRET = originalSecret;
    }
  });

  test("a confidential reply stores only the command's name and outcome; the link is only in its text", async () => {
    const originalUrl = Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL;
    const originalSecret = Bun.env.BELLACLAW_GATEWAY_SECRET;
    Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = "https://dashboard.test";
    Bun.env.BELLACLAW_GATEWAY_SECRET = "gateway-secret";

    try {
      await authorized("discord:100", "!dashboard now", 4);
    } finally {
      Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = originalUrl;
      Bun.env.BELLACLAW_GATEWAY_SECRET = originalSecret;
    }

    const [authorizedRow] = await rowsOf(EEventType.MessageAuthorized);
    const [reply] = await payloadsOf(EEventType.ReplyReady);
    expect(reply).toEqual({
      ...testMessageOrigin("discord:100", EMessagePlatform.Discord),
      text: expect.stringContaining("https://dashboard.test/link?token="),
      confidential: true,
      display: {
        text: "link sent",
        request: { text: "!dashboard", receivedAt: 4 },
        command: {
          runId: authorizedRow?.id,
          name: "dashboard",
          state: "done",
          outcome: "link sent",
        },
      },
    });
    expect(JSON.stringify((reply as { display: unknown }).display)).not.toContain("token=");
  });

  test("an MCP prompt command becomes turn.requested keyed by the chat with its trace", async () => {
    const configPath = join(directory, "connectors.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        connectors: [
          {
            id: "documents",
            description: "Documents",
            instructions: "Use document prompts",
            transport: { type: "stdio", command: "unused" },
            prompts: true,
          },
        ],
      }),
    );
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = configPath;

    await authorized("discord:channel-1", '!mcp-prompt documents summarize {"style":"brief"}', 5, [
      {
        id: "m:a",
        mimeType: "image/png",
        channel: EMessagePlatform.Discord,
        sourceAddress: "channel-1",
      },
    ]);

    const rows = await rowsOf(EEventType.TurnRequested);
    expect(rows[0]?.chatId).toBe("discord:channel-1");
    expect(rows[0]?.platform).toBe(EMessagePlatform.Discord);
    expect(rows[0]?.turnId).toBe("test:commands");
    expect(rows[0]?.payload).toEqual({
      ...testMessageOrigin("discord:channel-1", EMessagePlatform.Discord),
      content:
        'Use connector documents to run the explicitly requested prompt template summarize with arguments {"style":"brief"}.',
      attachments: [],
      receivedAt: 5,
    });
  });

  test("a command reply becomes reply.ready", async () => {
    const configPath = join(directory, "connectors.json");
    await Bun.write(configPath, JSON.stringify({ connectors: [] }));
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = configPath;

    await authorized("discord:channel-1", "!mcp-prompt missing summarize", 1);
    await Bun.write(configPath, JSON.stringify({ connectors: [{ id: "INVALID" }] }));
    await authorized("discord:channel-1", "!mcp-prompts", 2);

    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      {
        ...testMessageOrigin("discord:channel-1", EMessagePlatform.Discord),
        text: "MCP prompt request failed: Error: Unknown connector: missing",
        display: {
          text: "MCP prompt request failed: Error: Unknown connector: missing",
          request: { text: "!mcp-prompt missing summarize", receivedAt: 1 },
          command: {
            runId: expect.any(String),
            name: "mcp-prompt",
            state: "failed",
            outcome: "failed",
          },
        },
      },
      {
        ...testMessageOrigin("discord:channel-1", EMessagePlatform.Discord),
        text: expect.stringContaining(
          "MCP prompt listing failed: Error: Invalid connectors configuration:",
        ),
        display: {
          text: expect.stringContaining(
            "MCP prompt listing failed: Error: Invalid connectors configuration:",
          ),
          request: { text: "!mcp-prompts", receivedAt: 2 },
          command: {
            runId: expect.any(String),
            name: "mcp-prompts",
            state: "failed",
            outcome: "failed",
          },
        },
      },
    ]);
    expect(await payloadsOf(EEventType.TurnRequested)).toEqual([]);
  });
});
