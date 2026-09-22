import { z } from "zod";
import { McpService } from "../../mcp";
import { getMcpProfile, loadMcpProfiles } from "../../mcp/config";
import type { TCommand } from "./types";

const SPromptArguments = z.record(z.string(), z.string());

export const mcpPromptsCommand: TCommand = {
  name: "mcp-prompts",
  description: "List MCP profiles, or list a profile's prompt templates",
  usage: "!mcp-prompts [PROFILE]",
  handler: async (_chatId, args) => {
    const profileId = args.trim();
    if (profileId.length === 0) {
      return (
        (await loadMcpProfiles())
          .map((profile) => `${profile.id}: ${profile.description}`)
          .join("\n") || "No MCP profiles configured."
      );
    }
    const session = await McpService.instance.open({ chatId: _chatId, profileId });
    try {
      const list = session.tools.find((tool) => tool.name === "mcp-list-prompts");
      if (list === undefined) {
        return "This profile does not expose prompt templates.";
      }
      const result = await list.execute(crypto.randomUUID(), {});
      return result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    } finally {
      await session.close();
    }
  },
};

export const mcpPromptCommand: TCommand = {
  name: "mcp-prompt",
  description: "Ask the assistant to run an MCP prompt template",
  usage: "!mcp-prompt PROFILE PROMPT [JSON_ARGUMENTS]",
  handler: async (_chatId, args) => {
    const match = args.trim().match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
    const profileId = match?.[1];
    const promptName = match?.[2];
    if (profileId === undefined || promptName === undefined) {
      return "Usage: !mcp-prompt PROFILE PROMPT [JSON_ARGUMENTS]";
    }
    const profile = await getMcpProfile(profileId);
    if (!profile.prompts) {
      return "Prompts are disabled for this profile.";
    }
    let promptArguments: Record<string, string> = {};
    if (match?.[3] !== undefined) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(match[3]);
      } catch {
        return "Prompt arguments must be a JSON object of string values.";
      }
      const parsed = SPromptArguments.safeParse(decoded);
      if (!parsed.success) {
        return "Prompt arguments must be a JSON object of string values.";
      }
      promptArguments = parsed.data;
    }
    return {
      prompt: `Use MCP profile ${profileId} to run the explicitly requested prompt template ${promptName} with arguments ${JSON.stringify(promptArguments)}.`,
    };
  },
};
