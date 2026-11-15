import { EEventType } from "@bellaclaw/database";
import { getMcpAuthStatus } from "../mcp/auth";
import type { TCommand } from "./types";

const USAGE = "Usage: !mcp-auth connect|disconnect|status PROFILE or !mcp-auth token PROFILE TOKEN";

export const mcpAuthCommand: TCommand = {
  name: "mcp-auth",
  description:
    "Connect, disconnect, or check authentication for an OAuth or token MCP profile in this chat.",
  usage: "!mcp-auth connect|disconnect|status PROFILE | !mcp-auth token PROFILE TOKEN",
  handler: async (chatId, args, ctx) => {
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
        await ctx.request(
          EEventType.McpAuthTokenSaveRequested,
          { chatId, profileId, token },
          {
            outcome: EEventType.McpAuthTokenSaved,
            step: undefined,
            key: undefined,
            timeoutMs: undefined,
          },
        );
        return `Saved the token for MCP profile ${profileId} in this chat.`;
      }
      if (action === "connect") {
        const created = await ctx.request(
          EEventType.McpAuthConnectRequested,
          { chatId, profileId },
          {
            outcome: EEventType.McpAuthLinkCreated,
            step: undefined,
            key: undefined,
            timeoutMs: undefined,
          },
        );
        return `Open this link to connect ${profileId}:\n${created.payload.url}`;
      }
      if (action === "disconnect") {
        const outcome = await ctx.request(
          EEventType.McpAuthDisconnectRequested,
          { chatId, profileId },
          {
            outcome: EEventType.McpAuthDisconnected,
            step: undefined,
            key: undefined,
            timeoutMs: undefined,
          },
        );
        if (outcome.payload.disconnected) {
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
