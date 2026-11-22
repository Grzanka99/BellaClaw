import { EConnectorKind } from "@bellaclaw/database";
import { z } from "zod";
import { ConnectorService } from "../connectors";
import { getConnector, loadConnectors } from "../connectors/config";
import type { TCommand } from "./types";

const SPromptArguments = z.record(z.string(), z.string());

export const mcpPromptsCommand: TCommand = {
  name: "mcp-prompts",
  description: "List connectors, or list a connector's prompt templates",
  usage: "!mcp-prompts [CONNECTOR]",
  handler: async (ownerKey, args) => {
    try {
      const connectorId = args.trim();
      if (connectorId.length === 0) {
        return (
          (await loadConnectors(ownerKey))
            .map((connector) => `${connector.id}: ${connector.description}`)
            .join("\n") || "No connectors configured."
        );
      }
      const connector = await getConnector(ownerKey, connectorId);
      if (connector.kind !== EConnectorKind.Mcp) {
        return "This connector does not expose prompt templates.";
      }
      const session = await ConnectorService.instance.open({ ownerKey, connectorId });
      try {
        const list = session.tools.find((tool) => tool.name === "mcp-list-prompts");
        if (list === undefined) {
          return "This connector does not expose prompt templates.";
        }
        const result = await list.execute(crypto.randomUUID(), {});
        return result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      } finally {
        await session.close();
      }
    } catch (error) {
      return `MCP prompt listing failed: ${String(error)}`;
    }
  },
};

export const mcpPromptCommand: TCommand = {
  name: "mcp-prompt",
  description: "Ask the assistant to run an MCP prompt template",
  usage: "!mcp-prompt CONNECTOR PROMPT [JSON_ARGUMENTS]",
  handler: async (ownerKey, args) => {
    const match = args.trim().match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
    const connectorId = match?.[1];
    const promptName = match?.[2];
    if (connectorId === undefined || promptName === undefined) {
      return "Usage: !mcp-prompt CONNECTOR PROMPT [JSON_ARGUMENTS]";
    }
    try {
      const connector = await getConnector(ownerKey, connectorId);
      if (connector.kind !== EConnectorKind.Mcp) {
        return "This connector does not expose prompt templates.";
      }
      if (!connector.prompts) {
        return "Prompts are disabled for this connector.";
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
        prompt: `Use connector ${connectorId} to run the explicitly requested prompt template ${promptName} with arguments ${JSON.stringify(promptArguments)}.`,
      };
    } catch (error) {
      return `MCP prompt request failed: ${String(error)}`;
    }
  },
};
