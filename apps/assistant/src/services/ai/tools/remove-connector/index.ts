import { EEventType } from "@bellaclaw/database";
import { CONNECTOR_NOT_FOUND } from "@bellaclaw/shared";
import { obj, str } from "@earendil-works/pi-schema";
import { CommandRejectedError } from "../../../events";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SRemoveConnectorArgs = obj({
  id: str({ minLength: 1, description: "Connector id from list-connectors" }),
});

export const removeConnector = defineTool({
  name: "remove-connector",
  label: "Remove connector",
  description:
    "Remove one of the user's connectors. A connector still waiting for approval is gone at once; an active one waits for the user's approval of the removal.",
  schema: SRemoveConnectorArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  privateErrors: true,
  execute: async (context, args) => {
    const ownerKey = requireChatId(context.ownerKey);

    try {
      const changed = await context.events.request(
        EEventType.ConnectorRemoveRequested,
        { ownerKey, id: args.id },
        {
          outcome: EEventType.ConnectorsChanged,
          step: undefined,
          key: ownerKey,
          timeoutMs: undefined,
        },
      );

      if (changed.payload.connector === null) {
        return { id: args.id, status: "removed" };
      }

      return {
        id: args.id,
        status: changed.payload.connector.status,
        approvalCommand: `!connector approve ${args.id}`,
        rejectCommand: `!connector reject ${args.id}`,
      };
    } catch (error) {
      if (error instanceof CommandRejectedError && error.errorCode === CONNECTOR_NOT_FOUND) {
        throw new ToolError(
          error.errorCode,
          `${error.message}. Nothing was removed; only the user's own connectors from list-connectors can be removed`,
        );
      }

      throw error;
    }
  },
});
