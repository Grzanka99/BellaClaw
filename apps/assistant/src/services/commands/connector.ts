import { EConnectorStatus, EEventType } from "@bellaclaw/database";
import {
  COMMAND_CATALOG,
  CONNECTOR_NOT_FOUND,
  CONNECTOR_NOT_PENDING,
  type TCommandTone,
} from "@bellaclaw/shared";
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

const STATUS_TONE: Record<EConnectorStatus, TCommandTone> = {
  [EConnectorStatus.PendingAdd]: "warning",
  [EConnectorStatus.Active]: "good",
  [EConnectorStatus.PendingRemoval]: "warning",
};

// NOTE: the only way to approve or reject a connector change; only the user's own chat message runs it
export const connectorCommand: TCommand = {
  entry: COMMAND_CATALOG.connector,
  handler: async (chatId, args, ctx) => {
    const [action, id, extra] = args.trim().split(/\s+/);

    if (action === "list" && id === undefined) {
      const rows = await ConnectorService.instance.listStored(chatId);

      if (rows.length === 0) {
        return { text: "You have no added connectors.", state: "done", outcome: "no connectors" };
      }

      const text = rows
        .map((row) => {
          let access = "";

          if (row.plainChats) {
            access = ", open to plain chats";
          }

          return `- ${row.id} (${row.kind}, ${STATUS_TEXT[row.status]}${access}): ${row.url} — ${row.description}`;
        })
        .join("\n");

      return {
        text,
        state: "done",
        outcome: `${rows.length} connectors`,
        rows: rows.map((row) => ({
          title: row.id,
          status: { label: STATUS_TEXT[row.status], tone: STATUS_TONE[row.status] },
          detail: row.url,
        })),
      };
    }

    if ((action !== "approve" && action !== "reject") || id === undefined || extra !== undefined) {
      return { text: USAGE, state: "failed", outcome: "usage" };
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
        return { text: `You have no connector ${id}.`, state: "failed", outcome: "not found" };
      }

      if (error instanceof CommandRejectedError && error.errorCode === CONNECTOR_NOT_PENDING) {
        return {
          text: `Connector ${id} has nothing waiting for approval.`,
          state: "failed",
          outcome: "nothing pending",
        };
      }

      return {
        text: `Connector ${action} failed: ${String(error)}`,
        state: "failed",
        outcome: "failed",
      };
    }

    // approving an add or rejecting a removal leaves the connector; the other two delete it
    const connector = changed.payload.connector;

    if (action === "approve" && connector !== null) {
      return {
        text: `Connector ${id} is active: ${connector.url}`,
        state: "done",
        outcome: `${id} active`,
      };
    }

    if (action === "approve") {
      return { text: `Connector ${id} is removed.`, state: "done", outcome: `${id} removed` };
    }

    if (connector === null) {
      return {
        text: `The request to add connector ${id} was dropped.`,
        state: "done",
        outcome: `${id} dropped`,
      };
    }

    return { text: `Connector ${id} stays.`, state: "done", outcome: `${id} stays` };
  },
};
