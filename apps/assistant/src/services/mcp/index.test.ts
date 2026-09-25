import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { loadMcpProfiles } from "./config";
import { mcpResult } from "./content";
import { createFixtureServer } from "./fixtures/server";
import { McpService } from "./index";
import { discoverTools, type TMcpToolContext } from "./tools";
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
  test("loads the default logs profile for local and Compose URLs", async () => {
    const configPath = Bun.env.BELLACLAW_MCP_CONFIG;
    const previousLogsUrl = Bun.env.BELLACLAW_LOGS_MCP_URL;
    delete Bun.env.BELLACLAW_MCP_CONFIG;
    delete Bun.env.BELLACLAW_LOGS_MCP_URL;
    try {
      const localProfiles = await loadMcpProfiles();
      expect(localProfiles.map((profile) => profile.id)).toEqual(["logs"]);
      expect(localProfiles[0]?.transport).toMatchObject({
        type: "http",
        url: "http://127.0.0.1:8989/mcp",
      });

      Bun.env.BELLACLAW_LOGS_MCP_URL = "http://log-viewer:8989/mcp";
      const composeProfiles = await loadMcpProfiles();
      expect(composeProfiles[0]?.transport).toMatchObject({
        type: "http",
        url: "http://log-viewer:8989/mcp",
      });
    } finally {
      if (configPath !== undefined) {
        Bun.env.BELLACLAW_MCP_CONFIG = configPath;
      }
      if (previousLogsUrl === undefined) {
        delete Bun.env.BELLACLAW_LOGS_MCP_URL;
      } else {
        Bun.env.BELLACLAW_LOGS_MCP_URL = previousLogsUrl;
      }
    }
  });

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
    expect(JSON.stringify(read.parameters)).not.toContain('"excludeTurnId"');
    const valid = validateToolArguments(read, {
      type: "toolCall",
      id: "a",
      name: read.name,
      arguments: { query: "hi", chatId: "model-supplied", options: { limit: 2 } },
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
    const missingContext = await service.open({ chatId: "discord:missing", profileId: "fixture" });
    const missingContextRead = tool(missingContext, "read.foo");
    expect(JSON.stringify(missingContextRead.parameters)).not.toContain('"excludeTurnId"');
    await expect(
      missingContextRead.execute("spoofed", { query: "q", excludeTurnId: "model-supplied" }),
    ).rejects.toThrow("Invalid arguments");
    await expect(tool(session, "failure").execute("fail", {})).rejects.toThrow(
      "deliberate failure",
    );
    expect(
      (
        await tool(session, "read_foo").execute("open-schema", {
          chatId: "model-supplied",
          marker: "kept",
        })
      ).content[0],
    ).toEqual({ type: "text", text: JSON.stringify({ marker: "kept" }) });
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

  test("resource listing paginates and tolerates only unsupported template listing", async () => {
    await configure({ type: "stdio", command: "unused" });
    const [profile] = await loadMcpProfiles();
    if (profile === undefined) {
      throw new Error("Missing MCP test profile");
    }
    const resourceCursors: TOption<string>[] = [];
    const templateCursors: TOption<string>[] = [];
    let templateFailure: TOption<McpError>;
    const client = {
      getServerCapabilities: () => ({ resources: {} }),
      listResources: async ({ cursor }: { cursor?: string }) => {
        resourceCursors.push(cursor);
        if (cursor === undefined) {
          return {
            resources: [{ uri: "fixture://one", name: "one" }],
            nextCursor: "resources-next",
          };
        }
        return { resources: [{ uri: "fixture://two", name: "two" }] };
      },
      listResourceTemplates: async ({ cursor }: { cursor?: string }) => {
        templateCursors.push(cursor);
        if (templateFailure !== undefined) {
          throw templateFailure;
        }
        if (cursor === undefined) {
          return {
            resourceTemplates: [{ uriTemplate: "fixture://{first}", name: "first" }],
            nextCursor: "templates-next",
          };
        }
        return {
          resourceTemplates: [{ uriTemplate: "fixture://{second}", name: "second" }],
        };
      },
    } as unknown as Client;
    const context: TMcpToolContext = {
      client,
      profile,
      args: { chatId: "test", profileId: profile.id },
      signal: new AbortController().signal,
      updates: [],
    };
    const tools = await discoverTools(context);
    const list = tool(
      { profile, tools, signal: context.signal, close: async () => {} },
      "mcp-list-resources",
    );

    const paginated = await list.execute("paginated", {});
    expect(resourceCursors).toEqual([undefined, "resources-next"]);
    expect(templateCursors).toEqual([undefined, "templates-next"]);
    expect(JSON.stringify(paginated)).toContain("fixture://two");
    expect(JSON.stringify(paginated)).toContain("fixture://{second}");

    resourceCursors.length = 0;
    templateCursors.length = 0;
    templateFailure = new McpError(ErrorCode.MethodNotFound, "templates unsupported");
    const unsupported = await list.execute("unsupported", {});
    expect(resourceCursors).toEqual([undefined, "resources-next"]);
    expect(templateCursors).toEqual([undefined]);
    expect(JSON.stringify(unsupported)).toContain("fixture://two");
    const unsupportedContent = unsupported.content[0];
    if (unsupportedContent?.type !== "text") {
      throw new Error("Missing resource list result");
    }
    expect(JSON.parse(unsupportedContent.text).templates).toEqual([]);

    templateFailure = new McpError(ErrorCode.InternalError, "template failure");
    await expect(list.execute("failed", {})).rejects.toThrow("template failure");
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
