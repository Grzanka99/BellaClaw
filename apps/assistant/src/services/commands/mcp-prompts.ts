import { EConnectorKind } from "@bellaclaw/database";
import { COMMAND_CATALOG } from "@bellaclaw/shared";
import { z } from "zod";
import { ConnectorService } from "../connectors";
import { getConnector, loadConnectors } from "../connectors/config";
import type { TCommand, TCommandResult } from "./types";

const SPromptArguments = z.record(z.string(), z.string());
const NO_TEMPLATES: TCommandResult = {
  text: "This connector does not expose prompt templates.",
  state: "failed",
  outcome: "no prompt templates",
};
const BAD_ARGUMENTS: TCommandResult = {
  text: "Prompt arguments must be a JSON object of string values.",
  state: "failed",
  outcome: "bad arguments",
};

// the JSON the connector's mcp-list-prompts tool answers with
const SPromptList = z.object({
  prompts: z.array(z.object({ name: z.string(), description: z.string().optional() })),
});

export const mcpPromptsCommand: TCommand = {
  entry: COMMAND_CATALOG["mcp-prompts"],
  handler: async (ownerKey, args) => {
    try {
      const connectorId = args.trim();
      if (connectorId.length === 0) {
        const connectors = await loadConnectors(ownerKey);
        if (connectors.length === 0) {
          return { text: "No connectors configured.", state: "done", outcome: "no connectors" };
        }
        return {
          text: connectors
            .map((connector) => `${connector.id}: ${connector.description}`)
            .join("\n"),
          state: "done",
          outcome: `${connectors.length} connectors`,
          rows: connectors.map((connector) => ({
            title: connector.id,
            detail: connector.description,
          })),
        };
      }
      const connector = await getConnector(ownerKey, connectorId);
      if (connector.kind !== EConnectorKind.Mcp) {
        return NO_TEMPLATES;
      }
      const session = await ConnectorService.instance.open({ ownerKey, connectorId });
      try {
        const list = session.tools.find((tool) => tool.name === "mcp-list-prompts");
        if (list === undefined) {
          return NO_TEMPLATES;
        }
        const result = await list.execute(crypto.randomUUID(), {});
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const parsed = SPromptList.safeParse(JSON.parse(text));
        if (!parsed.success) {
          throw new Error("MCP prompt listing returned an unexpected shape");
        }
        return {
          text,
          state: "done",
          outcome: `${parsed.data.prompts.length} prompts`,
          rows: parsed.data.prompts.map((prompt) => ({
            title: prompt.name,
            detail: prompt.description,
          })),
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      return {
        text: `MCP prompt listing failed: ${String(error)}`,
        state: "failed",
        outcome: "failed",
      };
    }
  },
};

export const mcpPromptCommand: TCommand = {
  entry: COMMAND_CATALOG["mcp-prompt"],
  handler: async (ownerKey, args) => {
    const match = args.trim().match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
    const connectorId = match?.[1];
    const promptName = match?.[2];
    if (connectorId === undefined || promptName === undefined) {
      return {
        text: "Usage: !mcp-prompt CONNECTOR PROMPT [JSON_ARGUMENTS]",
        state: "failed",
        outcome: "usage",
      };
    }
    try {
      const connector = await getConnector(ownerKey, connectorId);
      if (connector.kind !== EConnectorKind.Mcp) {
        return NO_TEMPLATES;
      }
      if (!connector.prompts) {
        return {
          text: "Prompts are disabled for this connector.",
          state: "failed",
          outcome: "prompts disabled",
        };
      }
      let promptArguments: Record<string, string> = {};
      if (match?.[3] !== undefined) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(match[3]);
        } catch {
          return BAD_ARGUMENTS;
        }
        const parsed = SPromptArguments.safeParse(decoded);
        if (!parsed.success) {
          return BAD_ARGUMENTS;
        }
        promptArguments = parsed.data;
      }
      return {
        prompt: `Use connector ${connectorId} to run the explicitly requested prompt template ${promptName} with arguments ${JSON.stringify(promptArguments)}.`,
      };
    } catch (error) {
      return {
        text: `MCP prompt request failed: ${String(error)}`,
        state: "failed",
        outcome: "failed",
      };
    }
  },
};
