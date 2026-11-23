import { EConnectorKind, EConnectorStatus, EEventType } from "@bellaclaw/database";
import { CONNECTOR_EXISTS } from "@bellaclaw/shared";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { ConnectorService, type TConnectorProbe } from "../../../connectors";
import { ConnectorUrlError } from "../../../connectors/types";
import { CommandRejectedError } from "../../../events";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

const SERVER_NAMES: Record<EConnectorKind, string> = {
  [EConnectorKind.Mcp]: "an MCP server",
  [EConnectorKind.Utcp]: "a UTCP server",
};

export const SAddConnectorArgs = obj({
  id: str({
    pattern: "^[a-z][a-z0-9-]*$",
    description: "Short lowercase id: a letter, then letters, digits or hyphens",
  }),
  kind: oneOf([EConnectorKind.Mcp, EConnectorKind.Utcp], {
    description:
      "The protocol the user named; when they named none, try mcp and, if that cannot connect, utcp",
  }),
  url: str({
    pattern: "^https?://\\S+$",
    description: "The server's http or https URL, exactly as the user gave it",
  }),
  description: str({
    maxLength: 200,
    pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
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
    "Check that a URL is a reachable MCP or UTCP server, then ask to add it as the user's connector. It stays unusable until the user approves it.",
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
        { id: args.id, kind: args.kind, url: args.url, description: args.description, plainChats },
        signal,
      );
    } catch (error) {
      // our own text, naming no server-supplied detail
      if (error instanceof ConnectorUrlError) {
        throw new ToolError("connector-url-unsupported", `${error.message}. Nothing was added`);
      }

      throw new ToolError(
        "connector-unreachable",
        `Could not connect to ${args.url} as ${SERVER_NAMES[args.kind]}. Nothing was added`,
      );
    }

    try {
      await context.events.request(
        EEventType.ConnectorAddRequested,
        {
          ownerKey,
          id: args.id,
          kind: args.kind,
          url: args.url,
          description: args.description,
          plainChats,
        },
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
