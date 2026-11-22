import { EConnectorStatus, EEventType } from "@bellaclaw/database";
import { CONNECTOR_NOT_FOUND, CONNECTOR_NOT_PENDING } from "@bellaclaw/shared";
import { ConnectorService } from "../connectors";
import { CommandRejectedError } from "../events";
import type { TEvent } from "../events/catalog";
import type { TCommand } from "./types";

const USAGE = "Usage: !connector list | !connector approve|reject CONNECTOR";

const STATUS_TEXT: Record<EConnectorStatus, string> = {
  [EConnectorStatus.PendingAdd]: "waiting for approval to add",
  [EConnectorStatus.Active]: "active",
  [EConnectorStatus.PendingRemoval]: "waiting for approval to remove",
};

// NOTE: the only way to approve or reject a connector change; only the user's own chat message runs it
export const connectorCommand: TCommand = {
  name: "connector",
  description: "List your added connectors, or approve or reject a pending add or removal.",
  usage: "!connector list | !connector approve|reject CONNECTOR",
  handler: async (chatId, args, ctx) => {
    const [action, id, extra] = args.trim().split(/\s+/);

    if (action === "list" && id === undefined) {
      const rows = await ConnectorService.instance.listStored(chatId);

      if (rows.length === 0) {
        return "You have no added connectors.";
      }

      return rows
        .map((row) => `- ${row.id} (${STATUS_TEXT[row.status]}): ${row.url} — ${row.description}`)
        .join("\n");
    }

    if ((action !== "approve" && action !== "reject") || id === undefined || extra !== undefined) {
      return USAGE;
    }

    let changed: TEvent<EEventType.ConnectorsChanged>;

    try {
      changed = await ctx.request(
        EEventType.ConnectorResolveRequested,
        { ownerKey: chatId, id, decision: action },
        {
          outcome: EEventType.ConnectorsChanged,
          step: undefined,
          key: chatId,
          timeoutMs: undefined,
        },
      );
    } catch (error) {
      if (error instanceof CommandRejectedError && error.errorCode === CONNECTOR_NOT_FOUND) {
        return `You have no connector ${id}.`;
      }

      if (error instanceof CommandRejectedError && error.errorCode === CONNECTOR_NOT_PENDING) {
        return `Connector ${id} has nothing waiting for approval.`;
      }

      return `Connector ${action} failed: ${String(error)}`;
    }

    // approving an add or rejecting a removal leaves the connector; the other two delete it
    const connector = changed.payload.connector;

    if (action === "approve" && connector !== null) {
      return `Connector ${id} is active: ${connector.url}`;
    }

    if (action === "approve") {
      return `Connector ${id} is removed.`;
    }

    if (connector === null) {
      return `The request to add connector ${id} was dropped.`;
    }

    return `Connector ${id} stays.`;
  },
};
