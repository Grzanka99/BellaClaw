import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogger } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { McpService } from "../../assistant/src/services/mcp";
import { createLogViewerApp, type TLogViewerApplication } from "./app";

const STextToolResult = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

let application: TOption<TLogViewerApplication>;
let client: TOption<Client>;
let httpServer: TOption<ReturnType<typeof Bun.serve>>;
let mcpService: TOption<McpService>;
let previousMcpConfig: TOption<string>;
let tempDir: TOption<string>;

afterEach(async () => {
  await mcpService?.close();
  await client?.close();
  httpServer?.stop(true);
  await application?.close();

  if (previousMcpConfig === undefined) {
    delete Bun.env.BELLACLAW_MCP_CONFIG;
  } else {
    Bun.env.BELLACLAW_MCP_CONFIG = previousMcpConfig;
  }

  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }

  application = undefined;
  client = undefined;
  httpServer = undefined;
  mcpService = undefined;
  previousMcpConfig = undefined;
  tempDir = undefined;
});

describe("behavior log MCP server", () => {
  test("serves tools, resources, a turn template, and the diagnostic prompt over HTTP", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-mcp-"));
    const dbPath = join(tempDir, "logs.db");
    const logger = new AppLogger({ dbPath, stdout() {} });
    const chatId = "discord:mcp-chat";

    logger.record({
      trace: { turnId: "turn-mcp", chatId, platform: "discord" },
      event: "message.received",
      component: "messaging",
    });
    logger.record({
      trace: { turnId: "turn-mcp", chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 80, inputTokens: 100, agentName: "memory" },
    });
    logger.record({
      trace: { turnId: "turn-mcp", chatId, platform: "discord" },
      event: "handler.completed",
      component: "messaging",
    });
    await logger.close();

    await connectClient(dbPath);
    const tools = await client?.listTools();
    expect(tools?.tools.map((tool) => tool.name).sort()).toEqual([
      "cache_hit_rate",
      "latest_turn_latency",
      "recent_failures",
    ]);

    const cacheResult = await client?.callTool({
      name: "cache_hit_rate",
      arguments: { chatId, excludeTurnId: "diagnostic-turn" },
    });
    const parsedCacheResult = STextToolResult.safeParse(cacheResult);
    expect(parsedCacheResult.success).toBe(true);
    if (parsedCacheResult.success) {
      expect(parsedCacheResult.data.content[0]?.text).toContain('"cacheHitRatePercent": 80');
    }

    const resources = await client?.listResources();
    expect(resources?.resources.map((resource) => resource.uri)).toContain("logs://schema");
    const schema = await client?.readResource({ uri: "logs://schema" });
    const schemaContent = schema?.contents[0];
    if (schemaContent !== undefined && "text" in schemaContent) {
      expect(schemaContent.text).toContain('"model.request.completed metadata');
    }
    const templates = await client?.listResourceTemplates();
    expect(templates?.resourceTemplates[0]?.uriTemplate).toBe("logs://turn/{turnId}");

    const turn = await client?.readResource({ uri: "logs://turn/turn-mcp" });
    const turnContent = turn?.contents[0];
    expect(turnContent?.uri).toBe("logs://turn/turn-mcp");
    if (turnContent !== undefined && "text" in turnContent) {
      expect(turnContent.text).toContain('"event": "message.received"');
      expect(turnContent.text).toContain('"event": "handler.completed"');
    }

    const prompts = await client?.listPrompts();
    expect(prompts?.prompts.map((prompt) => prompt.name)).toContain("diagnose-turn");
    const prompt = await client?.getPrompt({
      name: "diagnose-turn",
      arguments: { turnId: "turn-mcp", chatId, excludeTurnId: "diagnostic-turn" },
    });
    expect(prompt?.messages[0]?.content.type).toBe("text");
    if (prompt?.messages[0]?.content.type === "text") {
      expect(prompt.messages[0].content.text).toContain("logs://turn/turn-mcp");
      expect(prompt.messages[0].content.text).toContain("excludeTurnId=diagnostic-turn");
    }
  });

  test("does not create an absent database when a tool is called", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-mcp-"));
    const dbPath = join(tempDir, "missing.db");
    await connectClient(dbPath);

    const result = await client?.callTool({
      name: "recent_failures",
      arguments: {},
    });

    expect(result?.isError).toBe(true);
    expect(await Bun.file(dbPath).exists()).toBe(false);
  });

  test("works through McpService with chat and diagnostic turn context injected", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-mcp-service-"));
    const dbPath = join(tempDir, "logs.db");
    const logger = new AppLogger({ dbPath, stdout() {} });
    const chatId = "discord:mcp-service-chat";

    logger.record({
      trace: { turnId: "before", chatId, platform: "discord" },
      event: "message.received",
      component: "messaging",
    });
    logger.record({
      trace: { turnId: "before", chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 30, inputTokens: 100 },
    });
    logger.record({
      trace: { turnId: "before", chatId, platform: "discord" },
      event: "handler.completed",
      component: "messaging",
    });
    logger.record({
      trace: { turnId: "diagnostic", chatId, platform: "discord" },
      event: "message.received",
      component: "messaging",
    });
    logger.record({
      trace: { turnId: "later", chatId, platform: "discord" },
      event: "message.received",
      component: "messaging",
    });
    logger.record({
      trace: { turnId: "later", chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 100, inputTokens: 100 },
    });
    logger.record({
      trace: { turnId: "later", chatId, platform: "discord" },
      event: "handler.completed",
      component: "messaging",
    });
    await logger.close();

    application = createLogViewerApp({ dbPath });
    httpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: application.app.fetch,
    });
    const configPath = join(tempDir, "mcp.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        profiles: [
          {
            id: "logs",
            description: "Behavior logs",
            instructions: "Inspect behavior logs",
            transport: { type: "http", url: `http://127.0.0.1:${httpServer.port}/mcp` },
            contextArguments: { chatId: "chatId", excludeTurnId: "turnId" },
          },
        ],
      }),
    );
    previousMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    Bun.env.BELLACLAW_MCP_CONFIG = configPath;
    mcpService = new McpService();
    const session = await mcpService.open({
      chatId,
      profileId: "logs",
      turnId: "diagnostic",
    });
    const cacheTool = session.tools.find((tool) => tool.label === "Cache hit rate");

    expect(cacheTool).toBeDefined();
    expect(JSON.stringify(cacheTool?.parameters)).not.toContain("chatId");
    expect(JSON.stringify(cacheTool?.parameters)).not.toContain("excludeTurnId");
    const result = await cacheTool?.execute("cache", {});
    const content = result?.content[0];
    expect(content?.type).toBe("text");

    if (content?.type === "text") {
      expect(content.text).toContain('"cacheHitRatePercent": 30');
      expect(content.text).toContain('"completedTurnCount": 1');
    }
  });
});

async function connectClient(dbPath: string) {
  application = createLogViewerApp({ dbPath });
  httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: application.app.fetch,
  });
  client = new Client({ name: "behavior-log-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpServer.port}/mcp`),
  );
  await client.connect(transport);
}
