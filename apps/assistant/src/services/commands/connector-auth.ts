import { EEventType } from "@bellaclaw/database";
import { COMMAND_CATALOG } from "@bellaclaw/shared";
import { getMcpAuthStatus } from "../connectors/mcp/auth";
import type { TCommand } from "./types";

const USAGE =
  "Usage: !connector-auth connect|disconnect|status CONNECTOR or !connector-auth token CONNECTOR TOKEN";

export const connectorAuthCommand: TCommand = {
  entry: COMMAND_CATALOG["connector-auth"],
  handler: async (chatId, args, ctx) => {
    const [action, connectorId, token, extra] = args.trim().split(/\s+/);
    const valid =
      action !== undefined &&
      connectorId !== undefined &&
      ((action === "token" && token !== undefined && extra === undefined) ||
        (["connect", "disconnect", "status"].includes(action) && token === undefined));
    // a malformed command may carry a token in any of its words, so the usage answer is
    // confidential and keeps the command out of the history
    if (!valid) {
      return { confidential: USAGE, state: "failed", outcome: "usage" };
    }

    try {
      if (action === "token" && token !== undefined) {
        await ctx.request(
          EEventType.McpAuthTokenSaveRequested,
          { chatId, profileId: connectorId, token },
          {
            outcome: EEventType.McpAuthTokenSaved,
            step: undefined,
            key: undefined,
            timeoutMs: undefined,
          },
        );
        return {
          confidential: `Saved the token for connector ${connectorId} in this chat.`,
          state: "done",
          outcome: `connector ${connectorId} connected`,
        };
      }
      if (action === "connect") {
        const created = await ctx.request(
          EEventType.McpAuthConnectRequested,
          { chatId, profileId: connectorId },
          {
            outcome: EEventType.McpAuthLinkCreated,
            step: undefined,
            key: undefined,
            timeoutMs: undefined,
          },
        );
        return {
          confidential: `Open this link to connect ${connectorId}:\n${created.payload.url}`,
          state: "done",
          outcome: "link sent",
        };
      }
      if (action === "disconnect") {
        const outcome = await ctx.request(
          EEventType.McpAuthDisconnectRequested,
          { chatId, profileId: connectorId },
          {
            outcome: EEventType.McpAuthDisconnected,
            step: undefined,
            key: undefined,
            timeoutMs: undefined,
          },
        );
        if (outcome.payload.disconnected) {
          return {
            text: `Disconnected connector ${connectorId}.`,
            state: "done",
            outcome: `${connectorId} disconnected`,
          };
        }
        return {
          text: `Connector ${connectorId} was not connected.`,
          state: "done",
          outcome: `${connectorId} was not connected`,
        };
      }

      const connected = await getMcpAuthStatus(chatId, connectorId);
      if (connected) {
        return {
          text: `Connector ${connectorId} is connected.`,
          state: "done",
          outcome: `${connectorId} connected`,
        };
      }
      return {
        text: `Connector ${connectorId} is not connected.`,
        state: "done",
        outcome: `${connectorId} not connected`,
      };
    } catch (error) {
      if (action === "token") {
        return {
          confidential: `Connector authentication failed: ${String(error)}`,
          state: "failed",
          outcome: "failed",
        };
      }
      return {
        text: `Connector authentication failed: ${String(error)}`,
        state: "failed",
        outcome: "failed",
      };
    }
  },
};
