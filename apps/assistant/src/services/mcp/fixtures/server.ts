import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  CreateMessageResultSchema,
  ElicitResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  type Tool,
  UnsubscribeRequestSchema,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";

export function createFixtureServer() {
  let requestedUrl = false;
  let refreshed = false;
  const server = new Server(
    { name: "fixture", version: "1" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true },
        prompts: {},
        completions: {},
      },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (request.params?.cursor === "next") {
      const tools: Tool[] = [
        { name: "read_foo", inputSchema: { type: "object" } },
        { name: "failure", inputSchema: { type: "object" } },
        { name: "sample", inputSchema: { type: "object" } },
        { name: "ask", inputSchema: { type: "object" } },
        { name: "wait", inputSchema: { type: "object" } },
        { name: "url", inputSchema: { type: "object" } },
        { name: "refresh-tools", inputSchema: { type: "object" } },
      ];
      if (refreshed) {
        tools.push({ name: "new-tool", inputSchema: { type: "object" } });
      }
      return { tools };
    }
    return {
      tools: [
        {
          name: "read.foo",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              chatId: { type: "string" },
              excludeTurnId: { type: "string" },
              options: {
                type: "object",
                properties: { limit: { anyOf: [{ type: "integer" }, { type: "null" }] } },
                required: ["limit"],
              },
            },
            required: ["query", "chatId"],
          },
        },
      ],
      nextCursor: "next",
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === "refresh-tools") {
      refreshed = true;
      await server.notification({ method: "notifications/tools/list_changed" });
    }
    if (request.params.name === "url" && !requestedUrl) {
      requestedUrl = true;
      throw new UrlElicitationRequiredError([
        {
          mode: "url",
          elicitationId: "connect",
          url: "https://example.com/connect",
          message: "Connect upstream",
        },
      ]);
    }
    if (request.params.name === "failure") {
      return { content: [{ type: "text", text: "deliberate failure" }], isError: true };
    }
    if (request.params.name === "sample") {
      const sampled = await extra.sendRequest(
        {
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: "Summarize fixture" } }],
            maxTokens: 100,
          },
        },
        CreateMessageResultSchema,
      );
      return { content: [{ type: "text", text: JSON.stringify(sampled) }] };
    }
    if (request.params.name === "ask") {
      const answer = await extra.sendRequest(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Which folder?",
            requestedSchema: {
              type: "object",
              properties: { folder: { type: "string" } },
              required: ["folder"],
            },
          },
        },
        ElicitResultSchema,
      );
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    }
    if (request.params.name === "wait") {
      await new Promise<void>((resolve) =>
        extra.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }],
      structuredContent: { pid: process.pid },
    };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "fixture://one", name: "one" }],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: "fixture://{name}", name: "named" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, text: "resource text" }],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: "summarize", arguments: [{ name: "topic", required: true }] }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: `Summarize ${request.params.arguments?.topic}` },
      },
    ],
  }));
  server.setRequestHandler(CompleteRequestSchema, async () => ({
    completion: { values: ["one", "two"], total: 2, hasMore: false },
  }));
  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    await server.notification({
      method: "notifications/resources/updated",
      params: { uri: request.params.uri },
    });
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
  return server;
}

if (import.meta.main) {
  await createFixtureServer().connect(new StdioServerTransport());
}
