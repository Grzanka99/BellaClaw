import { beginMcpAuth, disconnectMcpAuth, getMcpAuthStatus } from "../../mcp/auth";
import type { TCommand } from "./types";

const USAGE = "Usage: !mcp-auth connect|disconnect|status PROFILE";

export const mcpAuthCommand: TCommand = {
  name: "mcp-auth",
  description: "Connect, disconnect, or check authentication for an OAuth MCP profile.",
  usage: "!mcp-auth connect|disconnect|status PROFILE",
  handler: async (chatId, args) => {
    const [action, profileId, extra] = args.trim().split(/\s+/);
    if (
      action === undefined ||
      profileId === undefined ||
      extra !== undefined ||
      !["connect", "disconnect", "status"].includes(action)
    ) {
      return USAGE;
    }

    try {
      if (action === "connect") {
        const url = await beginMcpAuth(chatId, profileId);
        return `Open this link to connect ${profileId}:\n${url}`;
      }
      if (action === "disconnect") {
        const disconnected = await disconnectMcpAuth(chatId, profileId);
        if (disconnected) {
          return `Disconnected MCP profile ${profileId}.`;
        }
        return `MCP profile ${profileId} was not connected.`;
      }

      const connected = await getMcpAuthStatus(chatId, profileId);
      if (connected) {
        return `MCP profile ${profileId} is connected.`;
      }
      return `MCP profile ${profileId} is not connected.`;
    } catch (error) {
      return `MCP authentication failed: ${String(error)}`;
    }
  },
};
