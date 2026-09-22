import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Value } from "typebox/value";
import { loadMcpProfiles } from "./config";
import { mcpResult } from "./content";
import { createFixtureServer } from "./fixtures/server";
import { McpService } from "./index";
import type { TMcpSession } from "./types";

let directory: string;
let previousConfig: TOption<string>;
const service = new McpService();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-mcp-"));
  previousConfig = Bun.env.BELLACLAW_MCP_CONFIG;
  Bun.env.BELLACLAW_MCP_CONFIG = join(directory, "mcp.json");
});
afterEach(async () => {
  await service.close();
  if (previousConfig === undefined) {
    delete Bun.env.BELLACLAW_MCP_CONFIG;
  } else {
    Bun.env.BELLACLAW_MCP_CONFIG = previousConfig;
  }
  await rm(directory, { recursive: true, force: true });
});

async function configure(transport: object, extra: object = {}) {
  await Bun.write(
    join(directory, "mcp.json"),
    JSON.stringify({
      profiles: [
        {
          id: "fixture",
          description: "Fixture",
          instructions: "Use fixture tools",
          transport,
          contextArguments: { chatId: "chatId", excludeTurnId: "turnId" },
          ...extra,
        },
      ],
    }),
  );
}
function tool(session: TMcpSession, label: string) {
  const tool = session.tools.find(
    (candidate) => candidate.label === label || candidate.name === label,
  );
  if (tool === undefined) {
    throw new Error(`Missing tool ${label}`);
  }
  return tool;
}

describe("MCP runtime", () => {
  test("missing config disables MCP; malformed and duplicate profiles fail clearly", async () => {
    expect(await loadMcpProfiles()).toEqual([]);
    await configure({ type: "stdio", command: "bun" });
    const profiles = await loadMcpProfiles();
    await Bun.write(
      join(directory, "mcp.json"),
      JSON.stringify({ profiles: [profiles[0], profiles[0]] }),
    );
    await expect(loadMcpProfiles()).rejects.toThrow("Duplicate MCP profile");
    await Bun.write(join(directory, "mcp.json"), JSON.stringify({ profiles: [{ id: "invalid" }] }));
    await expect(loadMcpProfiles()).rejects.toThrow("Invalid MCP configuration");
    await configure({
      type: "http",
      url: "https://example.com/mcp",
      oauth: { clientSecretEnv: "SECRET" },
    });
    await expect(loadMcpProfiles()).rejects.toThrow("clientSecretEnv requires clientIdEnv");
  });

  test("stdio paginates tools, preserves schemas, isolates context and reports server errors", async () => {
    await configure({
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures/server.ts")],
    });
    const session = await service.open({
      chatId: "discord:a",
      profileId: "fixture",
      turnId: "turn:now",
    });
    const read = tool(session, "read.foo");
    expect(read.name).not.toBe(tool(session, "read_foo").name);
    expect(read.executionMode).toBe("parallel");
    expect(Value.Check(read.parameters, { query: "hello", options: { limit: null } })).toBe(true);
    expect(Value.Check(read.parameters, { query: 23 })).toBe(false);
    expect(JSON.stringify(read.parameters)).not.toContain('"chatId"');
    const valid = validateToolArguments(read, {
      type: "toolCall",
      id: "a",
      name: read.name,
      arguments: { query: "hi", options: { limit: 2 } },
    });
    const result = await read.execute("a", valid);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        query: "hi",
        options: { limit: 2 },
        chatId: "discord:a",
        excludeTurnId: "turn:now",
      }),
    });
    await expect(read.execute("bad", { query: 12 })).rejects.toThrow("Invalid arguments");
    await expect(tool(session, "failure").execute("fail", {})).rejects.toThrow(
      "deliberate failure",
    );
    const other = await service.open({
      chatId: "discord:b",
      profileId: "fixture",
      turnId: "other",
    });
    expect((await tool(other, "read.foo").execute("b", { query: "q" })).content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ query: "q", chatId: "discord:b", excludeTurnId: "other" }),
    });
    await service.disconnect("discord:a", "fixture");
    expect(session.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    await expect(read.execute("closed", { query: "q" })).rejects.toThrow();
    expect(
      (await tool(other, "read.foo").execute("still-open", { query: "q" })).content.length,
    ).toBeGreaterThan(0);
  });

  test("allowlists never expose excluded tools", async () => {
    await configure(
      {
        type: "stdio",
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures/server.ts")],
      },
      { tools: ["read.foo"], resources: false, prompts: false },
    );
    const session = await service.open({ chatId: "a", profileId: "fixture" });
    expect(session.tools).toHaveLength(1);
    expect(session.tools[0]?.label).toBe("read.foo");
  });

  test("URL prerequisites resume the original tool only after user acceptance", async () => {
    await configure({
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures/server.ts")],
    });
    let requests = 0;
    const session = await service.open({
      chatId: "a",
      profileId: "fixture",
      elicit: async (params) => {
        requests++;
        expect(params.mode).toBe("url");
        expect(params).toMatchObject({ url: "https://example.com/connect" });
        return { action: "accept" };
      },
    });
    expect((await tool(session, "url").execute("url", {})).content.length).toBeGreaterThan(0);
    expect(requests).toBe(1);
    const declined = await service.open({
      chatId: "b",
      profileId: "fixture",
      elicit: async () => ({ action: "decline" }),
    });
    await expect(tool(declined, "url").execute("url", {})).rejects.toThrow();
  });

  test("Streamable HTTP supports resources, prompts, completion, subscriptions, sampling and elicitation", async () => {
    const fixture = createFixtureServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await fixture.connect(transport);
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => transport.handleRequest(request),
    });
    try {
      await configure({ type: "http", url: `http://127.0.0.1:${http.port}/mcp` });
      let samples = 0;
      const session = await service.open({
        chatId: "a",
        profileId: "fixture",
        sample: async (params) => {
          samples++;
          expect(params.messages[0]?.content).toEqual({ type: "text", text: "Summarize fixture" });
          return {
            role: "assistant",
            model: "fixture",
            stopReason: "endTurn",
            content: { type: "text", text: "sampled" },
          };
        },
        elicit: async (params) => {
          expect(params.message).toBe("Which folder?");
          return { action: "accept", content: { folder: "inbox" } };
        },
      });
      expect(JSON.stringify(await tool(session, "mcp-list-resources").execute("r", {}))).toContain(
        "fixture://{name}",
      );
      expect(
        JSON.stringify(
          await tool(session, "mcp-read-resource").execute("r", { uri: "fixture://one" }),
        ),
      ).toContain("resource text");
      expect(JSON.stringify(await tool(session, "mcp-list-prompts").execute("p", {}))).toContain(
        "summarize",
      );
      expect(
        JSON.stringify(
          await tool(session, "mcp-get-prompt").execute("p", {
            name: "summarize",
            arguments: { topic: "logs" },
          }),
        ),
      ).toContain("Summarize logs");
      expect(
        JSON.stringify(
          await tool(session, "mcp-complete").execute("c", {
            kind: "resource",
            name: "fixture://{name}",
            argument: "name",
            value: "o",
          }),
        ),
      ).toContain("one");
      await tool(session, "mcp-subscribe-resource").execute("s", { uri: "fixture://one" });
      let updates = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        updates = JSON.stringify(await tool(session, "mcp-resource-updates").execute("u", {}));
        if (updates.includes("fixture://one")) {
          break;
        }
        await Bun.sleep(10);
      }
      expect(updates).toContain("fixture://one");
      await tool(session, "mcp-unsubscribe-resource").execute("us", { uri: "fixture://one" });
      expect(JSON.stringify(await tool(session, "sample").execute("s", {}))).toContain("sampled");
      expect(samples).toBe(1);
      expect(JSON.stringify(await tool(session, "ask").execute("e", {}))).toContain("inbox");
      const originalTools = session.tools;
      await tool(session, "refresh-tools").execute("refresh", {});
      for (let attempt = 0; attempt < 50; attempt++) {
        if (session.tools.some((candidate) => candidate.label === "new-tool")) {
          break;
        }
        await Bun.sleep(10);
      }
      expect(session.tools).toBe(originalTools);
      expect((await tool(session, "new-tool").execute("new", {})).content.length).toBeGreaterThan(
        0,
      );
      await session.close();
    } finally {
      await service.close();
      await fixture.close();
      await http.stop(true);
    }
  });

  test("aborting a call cancels its pending request", async () => {
    await configure({
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures/server.ts")],
    });
    const session = await service.open({ chatId: "a", profileId: "fixture" });
    const controller = new AbortController();
    const request = tool(session, "wait").execute("w", {}, controller.signal);
    controller.abort(new Error("cancel test"));
    await expect(request).rejects.toThrow();
  });

  test("normalizes rich results and bounds oversized output", () => {
    const result = mcpResult({
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///one", name: "one" },
      ],
      structuredContent: { answer: 42 },
    });
    expect(result.content[0]?.type).toBe("image");
    expect(JSON.stringify(result.content)).toContain("file:///one");
    expect(JSON.stringify(result.content)).toContain("42");
    expect(() => mcpResult({ content: [{ type: "text", text: "x".repeat(1024 * 1024) }] })).toThrow(
      "exceeds",
    );
  });
});
