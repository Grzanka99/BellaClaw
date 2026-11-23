import { EEventType } from "@bellaclaw/database";
import { CONNECTOR_NOT_FOUND } from "@bellaclaw/shared";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { CommandRejectedError } from "../../../events";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SUpdateConnectorArgs = obj({
  id: str({ minLength: 1, description: "Connector id from list-connectors" }),
  description: opt(
    str({
      maxLength: 200,
      pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
      description: "New one-line description saying when to use the server",
    }),
  ),
  plainChats: opt(bool({ description: "true lets the app's plain chats use it" })),
});

export const updateConnector = defineTool({
  name: "update-connector",
  label: "Update connector",
  description:
    "Change the description of one of the user's connectors, or whether the app's plain chats may use it.",
  schema: SUpdateConnectorArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  privateErrors: true,
  execute: async (context, args) => {
    const ownerKey = requireChatId(context.ownerKey);

    if (args.description === undefined && args.plainChats === undefined) {
      throw new ToolError(
        "invalid-update",
        "Give a new description or plainChats; nothing was changed",
      );
    }

    try {
      const changed = await context.events.request(
        EEventType.ConnectorUpdateRequested,
        { ownerKey, id: args.id, description: args.description, plainChats: args.plainChats },
        {
          outcome: EEventType.ConnectorsChanged,
          step: undefined,
          key: ownerKey,
          timeoutMs: undefined,
        },
      );
      const connector = changed.payload.connector;

      if (connector === null) {
        throw new Error(`Connector ${args.id} is gone`);
      }

      return {
        id: args.id,
        description: connector.description,
        plainChats: connector.plainChats,
        status: connector.status,
      };
    } catch (error) {
      if (error instanceof CommandRejectedError && error.errorCode === CONNECTOR_NOT_FOUND) {
        throw new ToolError(
          error.errorCode,
          `${error.message}. Nothing was changed; only the user's own connectors from list-connectors can be changed`,
        );
      }

      throw error;
    }
  },
});
