import {
  beginMcpAuth,
  disconnectMcpAuth,
  getMcpAuthStatus,
  saveMcpAuthToken,
} from "../../mcp/auth";
import type { TCommand } from "./types";

const USAGE = "Usage: !mcp-auth connect|disconnect|status PROFILE or !mcp-auth token PROFILE TOKEN";

export const mcpAuthCommand: TCommand = {
  name: "mcp-auth",
  description:
    "Connect, disconnect, or check authentication for an OAuth or token MCP profile in this chat.",
  usage: "!mcp-auth connect|disconnect|status PROFILE | !mcp-auth token PROFILE TOKEN",
  handler: async (chatId, args) => {
    const [action, profileId, token, extra] = args.trim().split(/\s+/);
    if (action === "token") {
      if (profileId === undefined || token === undefined || extra !== undefined) {
        return USAGE;
      }
    } else if (
      action === undefined ||
      profileId === undefined ||
      token !== undefined ||
      !["connect", "disconnect", "status"].includes(action)
    ) {
      return USAGE;
    }

    try {
      if (action === "token" && token !== undefined) {
        await saveMcpAuthToken(chatId, profileId, token);
        return `Saved the token for MCP profile ${profileId} in this chat.`;
      }
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
