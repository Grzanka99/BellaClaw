import { EConnectorStatus, EEventType } from "@bellaclaw/database";
import { CONNECTOR_EXISTS } from "@bellaclaw/shared";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { ConnectorService, type TConnectorProbe } from "../../../connectors";
import { CommandRejectedError } from "../../../events";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SAddConnectorArgs = obj({
  id: str({
    pattern: "^[a-z][a-z0-9-]*$",
    description: "Short lowercase id: a letter, then letters, digits or hyphens",
  }),
  url: str({
    pattern: "^https?://\\S+$",
    description: "The server's http or https URL, exactly as the user gave it",
  }),
  description: str({
    minLength: 1,
    pattern: "\\S",
    description: "One line saying when to use this server",
  }),
  plainChats: opt(
    bool({ description: "true lets the app's plain chats use it; false when omitted" }),
  ),
});

export const addConnector = defineTool({
  name: "add-connector",
  label: "Add connector",
  description:
    "Check that a URL is a reachable MCP server, then ask to add it as the user's connector. It stays unusable until the user approves it.",
  schema: SAddConnectorArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  privateErrors: true,
  execute: async (context, args, signal) => {
    const ownerKey = requireChatId(context.ownerKey);
    const plainChats = args.plainChats ?? false;
    let probe: TConnectorProbe;

    // NOTE: the result names only the URL; an unapproved server's error text is untrusted
    try {
      probe = await ConnectorService.instance.probe(
        ownerKey,
        { id: args.id, url: args.url, description: args.description, plainChats },
        signal,
      );
    } catch (_error) {
      throw new ToolError(
        "connector-unreachable",
        `Could not connect to ${args.url} as an MCP server. Nothing was added`,
      );
    }

    try {
      await context.events.request(
        EEventType.ConnectorAddRequested,
        { ownerKey, id: args.id, url: args.url, description: args.description, plainChats },
        {
          outcome: EEventType.ConnectorsChanged,
          step: undefined,
          key: ownerKey,
          timeoutMs: undefined,
        },
      );
    } catch (error) {
      if (error instanceof CommandRejectedError && error.errorCode === CONNECTOR_EXISTS) {
        throw new ToolError(
          error.errorCode,
          `${error.message}. Nothing was added; pick another id or call list-connectors`,
        );
      }

      throw error;
    }

    const commands = {
      approvalCommand: `!connector approve ${args.id}`,
      rejectCommand: `!connector reject ${args.id}`,
    };

    // after approval the user saves credentials with one of these commands
    if (probe.status === "auth_required") {
      return {
        id: args.id,
        status: EConnectorStatus.PendingAdd,
        authenticationRequired: true,
        ...commands,
        tokenCommand: `!connector-auth token ${args.id} TOKEN`,
        connectCommand: `!connector-auth connect ${args.id}`,
      };
    }

    return {
      id: args.id,
      status: EConnectorStatus.PendingAdd,
      toolCount: probe.toolCount,
      ...commands,
    };
  },
});
