import type { TOption } from "@bellaclaw/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type ResourceUpdatedNotification,
  type Tool,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { z } from "zod";
import type { TMcpProfile } from "./config";
import { mcpJsonResult, mcpResult } from "./content";
import type { TMcpOpenArgs } from "./types";

const SObjectArguments = z.record(z.string(), z.unknown());
const SEmpty = Type.Object({});
const SResource = Type.Object({ uri: Type.String({ minLength: 1 }) });
const SPrompt = Type.Object({
  name: Type.String({ minLength: 1 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
});
const SCompletion = Type.Object({
  kind: Type.Union([Type.Literal("prompt"), Type.Literal("resource")]),
  name: Type.String(),
  argument: Type.String(),
  value: Type.String(),
  arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export type TMcpToolContext = {
  client: Client;
  profile: TMcpProfile;
  args: TMcpOpenArgs;
  signal: AbortSignal;
  updates: ResourceUpdatedNotification["params"][];
};

export function requestOptions(context: TMcpToolContext, signal?: AbortSignal): RequestOptions {
  let combined = context.signal;
  if (signal !== undefined) {
    combined = AbortSignal.any([context.signal, signal]);
  }
  return {
    signal: combined,
    timeout: context.profile.requestTimeoutMs + context.profile.inputTimeoutMs,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: context.profile.requestTimeoutMs + context.profile.inputTimeoutMs,
  };
}

export async function discoverTools(context: TMcpToolContext): Promise<AgentTool[]> {
  const { client, profile } = context;
  const tools: AgentTool[] = [];
  if (client.getServerCapabilities()?.tools !== undefined) {
    let cursor: TOption<string>;
    const cursors = new Set<string>();
    const names = new Set<string>();
    do {
      const result = await client.listTools({ cursor }, requestOptions(context));
      for (const tool of result.tools) {
        if (profile.tools !== undefined && !profile.tools.includes(tool.name)) {
          continue;
        }
        if (names.has(tool.name)) {
          throw new Error(`MCP server returned duplicate tool: ${tool.name}`);
        }
        names.add(tool.name);
        tools.push(remoteTool(context, tool));
      }
      cursor = result.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) {
          throw new Error("MCP tool discovery returned a repeated pagination cursor");
        }
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
  }
  return [...tools, ...capabilityTools(context)];
}

function remoteTool(context: TMcpToolContext, tool: Tool): AgentTool {
  const properties = { ...tool.inputSchema.properties };
  const injected: Record<string, string> = {};
  const contextArgumentNames = new Set<string>();
  for (const [name, source] of Object.entries(context.profile.contextArguments)) {
    if (!(name in properties)) {
      continue;
    }
    contextArgumentNames.add(name);
    delete properties[name];
    const value = context.args[source];
    if (value !== undefined) {
      injected[name] = value;
    }
  }
  const parameters = {
    ...tool.inputSchema,
    properties,
    required: tool.inputSchema.required?.filter((name) => !contextArgumentNames.has(name)),
  };
  // Stable provider-safe names; the original name stays in the server request.
  const suffix = new Bun.CryptoHasher("sha256").update(tool.name).digest("hex").slice(0, 10);
  const name = `mcp_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 45)}_${suffix}`;
  let executionMode: "parallel" | "sequential" = "sequential";
  if (tool.annotations?.readOnlyHint === true) {
    executionMode = "parallel";
  }
  return {
    name,
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.name,
    parameters,
    executionMode,
    execute: async (_id, args: unknown, signal) => {
      const parsed = SObjectArguments.safeParse(args);
      if (!parsed.success) {
        throw new Error("MCP tool arguments must be a structured object");
      }
      const argumentsWithContext = { ...parsed.data };
      for (const name of contextArgumentNames) {
        delete argumentsWithContext[name];
      }
      Object.assign(argumentsWithContext, injected);
      if (!Value.Check(tool.inputSchema, argumentsWithContext)) {
        throw new Error(`Invalid arguments for MCP tool ${tool.name}`);
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          const result = await context.client.callTool(
            { name: tool.name, arguments: argumentsWithContext },
            CallToolResultSchema,
            requestOptions(context, signal),
          );
          const parsedResult = CallToolResultSchema.safeParse(result);
          if (!parsedResult.success) {
            throw new Error(`Invalid MCP result from ${tool.name}`);
          }
          return mcpResult(parsedResult.data);
        } catch (error) {
          if (
            !(error instanceof UrlElicitationRequiredError) ||
            context.args.elicit === undefined
          ) {
            throw error;
          }
          // Only this explicit protocol prerequisite permits a retry. Network failures
          // and uncertain tool outcomes are returned to the agent without replaying them.
          for (const elicitation of error.elicitations) {
            const answer = await context.args.elicit(
              {
                ...elicitation,
                message: `${elicitation.message}\nComplete the action at this URL, then reply to continue.`,
              },
              requestOptions(context, signal).signal ?? context.signal,
            );
            if (answer.action !== "accept") {
              throw new Error(`MCP URL interaction ${answer.action}`);
            }
          }
        }
      }
      throw new Error("MCP URL interaction exceeded its continuation limit");
    },
  };
}

function capabilityTools(context: TMcpToolContext): AgentTool[] {
  const tools: AgentTool[] = [];
  const { client, profile } = context;
  const capabilities = client.getServerCapabilities();
  if (profile.resources && capabilities?.resources !== undefined) {
    tools.push(
      metaTool(
        "mcp-list-resources",
        "List available resources and resource URI templates",
        SEmpty,
        async (_args, signal) => {
          const resources = [];
          const templates = [];
          let cursor: TOption<string>;
          const seen = new Set<string>();
          do {
            const page = await client.listResources({ cursor }, requestOptions(context, signal));
            resources.push(...page.resources);
            cursor = page.nextCursor;
            if (cursor !== undefined && seen.has(cursor)) {
              throw new Error("MCP resource discovery repeated its cursor");
            }
            if (cursor !== undefined) {
              seen.add(cursor);
            }
          } while (cursor !== undefined);
          seen.clear();
          try {
            do {
              const page = await client.listResourceTemplates(
                { cursor },
                requestOptions(context, signal),
              );
              templates.push(...page.resourceTemplates);
              cursor = page.nextCursor;
              if (cursor !== undefined && seen.has(cursor)) {
                throw new Error("MCP resource template discovery repeated its cursor");
              }
              if (cursor !== undefined) {
                seen.add(cursor);
              }
            } while (cursor !== undefined);
          } catch (error) {
            if (!(error instanceof McpError) || error.code !== ErrorCode.MethodNotFound) {
              throw error;
            }
            templates.length = 0;
          }
          return { resources, templates };
        },
      ),
      metaTool("mcp-read-resource", "Read a resource by its URI", SResource, (args, signal) =>
        client.readResource(args, requestOptions(context, signal)),
      ),
    );
    if (capabilities.resources.subscribe) {
      tools.push(
        metaTool(
          "mcp-subscribe-resource",
          "Subscribe to updates for a resource for this specialist session",
          SResource,
          (args, signal) => client.subscribeResource(args, requestOptions(context, signal)),
        ),
        metaTool(
          "mcp-unsubscribe-resource",
          "Stop updates for a resource",
          SResource,
          (args, signal) => client.unsubscribeResource(args, requestOptions(context, signal)),
        ),
        metaTool(
          "mcp-resource-updates",
          "Read resource update notifications received during this session",
          SEmpty,
          async () => context.updates.splice(0),
        ),
      );
    }
  }
  if (profile.prompts && capabilities?.prompts !== undefined) {
    tools.push(
      metaTool(
        "mcp-list-prompts",
        "List server prompt templates; use a template only when the user or scheduled task requests it",
        SEmpty,
        async (_args, signal) => {
          const prompts = [];
          let cursor: TOption<string>;
          const seen = new Set<string>();
          do {
            const page = await client.listPrompts({ cursor }, requestOptions(context, signal));
            prompts.push(...page.prompts);
            cursor = page.nextCursor;
            if (cursor !== undefined && seen.has(cursor)) {
              throw new Error("MCP prompt discovery repeated its cursor");
            }
            if (cursor !== undefined) {
              seen.add(cursor);
            }
          } while (cursor !== undefined);
          return { prompts };
        },
      ),
      metaTool(
        "mcp-get-prompt",
        "Render an explicitly requested server prompt template",
        SPrompt,
        (args, signal) => client.getPrompt(args, requestOptions(context, signal)),
      ),
    );
  }
  if (capabilities?.completions !== undefined && (profile.resources || profile.prompts)) {
    tools.push(
      metaTool(
        "mcp-complete",
        "Complete a resource template or prompt argument",
        SCompletion,
        async (args, signal) => {
          let ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };
          if (args.kind === "prompt") {
            if (!profile.prompts) {
              throw new Error("Prompts are disabled for this profile");
            }
            ref = { type: "ref/prompt", name: args.name };
          } else {
            if (!profile.resources) {
              throw new Error("Resources are disabled for this profile");
            }
            ref = { type: "ref/resource", uri: args.name };
          }
          return client.complete(
            {
              ref,
              argument: { name: args.argument, value: args.value },
              context: { arguments: args.arguments },
            },
            requestOptions(context, signal),
          );
        },
      ),
    );
  }
  return tools;
}

function metaTool<T extends TSchema>(
  name: string,
  description: string,
  schema: T,
  run: (args: Static<T>, signal?: AbortSignal) => Promise<unknown>,
): AgentTool<T> {
  return {
    name,
    label: name,
    description,
    parameters: schema,
    executionMode: "parallel",
    execute: async (_id, args, signal) => {
      if (!Value.Check(schema, args)) {
        throw new Error(`Invalid arguments for ${name}`);
      }
      return mcpJsonResult(await run(args, signal));
    },
  };
}
