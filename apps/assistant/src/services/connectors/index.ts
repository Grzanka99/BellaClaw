import { connectorsTable, EConnectorKind, EConnectorStatus, EEventType } from "@bellaclaw/database";
import {
  CONNECTOR_EXISTS,
  CONNECTOR_NOT_FOUND,
  CONNECTOR_NOT_PENDING,
  SConnectorId,
  type TOption,
} from "@bellaclaw/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DatabaseConnector, type TDatabaseTransaction } from "../database";
import { commandFailed, ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { ERejectionCode } from "../events/catalog";
import { EIdentityLinkOwner } from "../identity/schema";
import {
  getConnector,
  loadFileConnectors,
  storedConnector,
  type TStoredConnectorFields,
} from "./config";
import { mcpAdapter } from "./mcp";
import {
  ConnectorAuthRequiredError,
  type TConnectorOpenArgs,
  type TConnectorProbe,
  type TConnectorSession,
} from "./types";

export type { TConnectorOpenArgs, TConnectorProbe, TConnectorSession } from "./types";

const SConnectorUrl = z.url({ protocol: /^https?$/ });

export type TStoredConnector = typeof connectorsTable.$inferSelect;

// an expected refusal of a connector command; errorCode: undefined for invalid input
class ConnectorRejection extends Error {
  public constructor(
    public readonly errorCode: TOption<string>,
    message: string,
  ) {
    super(message);
  }
}

export class ConnectorService {
  private static _instance: ConnectorService;
  private sessions = new Map<TConnectorSession, { ownerKey: string; connectorId: string }>();

  public static get instance() {
    if (ConnectorService._instance === undefined) {
      ConnectorService._instance = new ConnectorService();
    }
    return ConnectorService._instance;
  }

  public setup(): void {
    // live: closing sessions must not replay after a restart
    EventBus.instance.subscribe({
      consumer: "mcp-sessions",
      type: EEventType.McpAuthCredentialsChanged,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: (event) => this.disconnect(event.payload.chatId, event.payload.profileId),
    });
    // a stored connector that is gone closes its sessions
    EventBus.instance.subscribe({
      consumer: "mcp-sessions",
      type: EEventType.ConnectorsChanged,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        if (event.payload.connector === null) {
          await this.disconnect(event.payload.ownerKey, event.payload.connectorId);
        }
      },
    });

    EventBus.instance.subscribe({
      consumer: "connectors",
      type: EEventType.ConnectorAddRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { ownerKey, id, url, description, plainChats } = event.payload;

        if (!SConnectorId.safeParse(id).success) {
          await this.reject(ctx, event.type, new ConnectorRejection(undefined, `Invalid id ${id}`));
          return;
        }

        if (!SConnectorUrl.safeParse(url).success) {
          await this.reject(
            ctx,
            event.type,
            new ConnectorRejection(undefined, "The URL must be an http or https URL"),
          );
          return;
        }

        if (description.trim().length === 0) {
          await this.reject(
            ctx,
            event.type,
            new ConnectorRejection(undefined, "The description is empty"),
          );
          return;
        }

        let fileIds: string[];

        try {
          fileIds = (await loadFileConnectors()).map((connector) => connector.id);
        } catch (error) {
          await this.reject(ctx, event.type, error);
          return;
        }

        if (fileIds.includes(id)) {
          await this.reject(
            ctx,
            event.type,
            new ConnectorRejection(CONNECTOR_EXISTS, `Connector ${id} already exists`),
          );
          return;
        }

        await this.answer(ctx, event.type, ownerKey, id, async (tx) => {
          if ((await this.find(tx, ownerKey, id)) !== undefined) {
            throw new ConnectorRejection(CONNECTOR_EXISTS, `Connector ${id} already exists`);
          }

          const now = new Date();
          const [row] = await tx
            .insert(connectorsTable)
            .values({
              ownerKey,
              id,
              kind: EConnectorKind.Mcp,
              url,
              description: description.trim(),
              plainChats,
              status: EConnectorStatus.PendingAdd,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return row;
        });
      },
    });

    EventBus.instance.subscribe({
      consumer: "connectors",
      type: EEventType.ConnectorUpdateRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { ownerKey, id, description, plainChats } = event.payload;

        if (description !== undefined && description.trim().length === 0) {
          await this.reject(
            ctx,
            event.type,
            new ConnectorRejection(undefined, "The description is empty"),
          );
          return;
        }

        await this.answer(ctx, event.type, ownerKey, id, async (tx) => {
          await this.owned(tx, ownerKey, id);
          const [row] = await tx
            .update(connectorsTable)
            .set({ description: description?.trim(), plainChats, updatedAt: new Date() })
            .where(and(eq(connectorsTable.ownerKey, ownerKey), eq(connectorsTable.id, id)))
            .returning();
          return row;
        });
      },
    });

    EventBus.instance.subscribe({
      consumer: "connectors",
      type: EEventType.ConnectorRemoveRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { ownerKey, id } = event.payload;

        await this.answer(ctx, event.type, ownerKey, id, async (tx) => {
          const row = await this.owned(tx, ownerKey, id);

          if (row.status === EConnectorStatus.PendingAdd) {
            await this.delete(tx, ownerKey, id);
            return undefined;
          }

          if (row.status === EConnectorStatus.PendingRemoval) {
            return row;
          }

          return this.setStatus(tx, ownerKey, id, EConnectorStatus.PendingRemoval);
        });
      },
    });

    EventBus.instance.subscribe({
      consumer: "connectors",
      type: EEventType.ConnectorResolveRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { ownerKey, id, decision } = event.payload;

        await this.answer(ctx, event.type, ownerKey, id, async (tx) => {
          const row = await this.owned(tx, ownerKey, id);

          if (row.status === EConnectorStatus.Active) {
            throw new ConnectorRejection(
              CONNECTOR_NOT_PENDING,
              `Connector ${id} has nothing pending`,
            );
          }

          // approving an add or rejecting a removal leaves it active; the other two remove it
          const added = row.status === EConnectorStatus.PendingAdd;

          if (added === (decision === "approve")) {
            return this.setStatus(tx, ownerKey, id, EConnectorStatus.Active);
          }

          await this.delete(tx, ownerKey, id);
          return undefined;
        });
      },
    });
    // NOTE: every connector of the address goes to the account with its status; on an id clash the
    // account's row stays and the address's is deleted
    EventBus.instance.subscribe({
      consumer: "connectors",
      type: EEventType.IdentityLinkQuiet,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000],
      handler: async (event, ctx) => {
        const { chatKey, ownerKey } = event.payload;

        await ctx.complete(async (tx, emit) => {
          const movingIds = (
            await tx
              .select({ id: connectorsTable.id })
              .from(connectorsTable)
              .where(eq(connectorsTable.ownerKey, chatKey))
          ).map((row) => row.id);

          if (movingIds.length > 0) {
            const clashingIds = (
              await tx
                .select({ id: connectorsTable.id })
                .from(connectorsTable)
                .where(
                  and(
                    eq(connectorsTable.ownerKey, ownerKey),
                    inArray(connectorsTable.id, movingIds),
                  ),
                )
            ).map((row) => row.id);
            await tx
              .delete(connectorsTable)
              .where(
                and(
                  eq(connectorsTable.ownerKey, chatKey),
                  inArray(connectorsTable.id, clashingIds),
                ),
              );
            await tx
              .update(connectorsTable)
              .set({ ownerKey })
              .where(eq(connectorsTable.ownerKey, chatKey));
          }

          // the address's connectors are gone, so its open sessions close
          for (const connectorId of movingIds) {
            emit(
              EEventType.ConnectorsChanged,
              { ownerKey: chatKey, connectorId, connector: null },
              connectorId,
              undefined,
            );
          }

          emit(
            EEventType.IdentityLinkMoved,
            { ...event.payload, owner: EIdentityLinkOwner.Connectors },
            undefined,
            undefined,
          );
        });
      },
    });
  }

  public async open(args: TConnectorOpenArgs): Promise<TConnectorSession> {
    const connector = await getConnector(args.ownerKey, args.connectorId);
    const session = await mcpAdapter.open(connector, args);
    this.sessions.set(session, { ownerKey: args.ownerKey, connectorId: connector.id });
    session.signal.addEventListener("abort", () => this.sessions.delete(session), { once: true });
    return session;
  }

  // opens the server once as the stored connector would be and counts its own tools; a request for
  // credentials gives auth_required, any other failure throws
  public async probe(
    ownerKey: string,
    fields: TStoredConnectorFields,
    signal: TOption<AbortSignal>,
  ): Promise<TConnectorProbe> {
    // inputTimeoutMs: the probe asks the user nothing, so a request ends at the request timeout
    const connector = {
      ...storedConnector(fields),
      resources: false,
      prompts: false,
      inputTimeoutMs: 0,
    };
    let session: TConnectorSession;

    try {
      session = await mcpAdapter.open(connector, { ownerKey, connectorId: connector.id, signal });
    } catch (error) {
      if (error instanceof ConnectorAuthRequiredError) {
        return { status: "auth_required" };
      }
      throw error;
    }

    const toolCount = session.tools.length;
    await session.close();
    return { status: "ready", toolCount };
  }

  // the owner's stored connectors in every status, oldest first
  public async listStored(ownerKey: string): Promise<TStoredConnector[]> {
    return DatabaseConnector.instance.run((db) =>
      db
        .select()
        .from(connectorsTable)
        .where(eq(connectorsTable.ownerKey, ownerKey))
        .orderBy(asc(connectorsTable.createdAt)),
    );
  }

  public async disconnect(chatId: string, connectorId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [session, owner] of this.sessions) {
      if (owner.ownerKey === chatId && owner.connectorId === connectorId) {
        closing.push(session.close());
      }
    }
    await Promise.all(closing);
  }

  public async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((session) => session.close()));
  }

  // runs change and answers with connectors.changed carrying the row it returns (undefined: the
  // row is gone), or with command.rejected for the rejection it throws
  private async answer(
    ctx: TEventContext,
    commandType: EEventType,
    ownerKey: string,
    connectorId: string,
    change: (tx: TDatabaseTransaction) => Promise<TOption<TStoredConnector>>,
  ): Promise<void> {
    try {
      await ctx.complete(async (tx, emit) => {
        const row = await change(tx);
        let connector = null;

        if (row !== undefined) {
          connector = {
            kind: row.kind,
            url: row.url,
            description: row.description,
            plainChats: row.plainChats,
            status: row.status,
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
          };
        }

        emit(
          EEventType.ConnectorsChanged,
          { ownerKey, connectorId, connector },
          undefined,
          undefined,
        );
      });
    } catch (error) {
      await this.reject(ctx, commandType, error);
    }
  }

  private async reject(ctx: TEventContext, commandType: EEventType, error: unknown): Promise<void> {
    await ctx.complete(async (_tx, emit) => {
      if (error instanceof ConnectorRejection) {
        emit(
          EEventType.CommandRejected,
          {
            commandType,
            code: ERejectionCode.Invalid,
            message: error.message,
            errorCode: error.errorCode,
          },
          undefined,
          undefined,
        );
        return;
      }

      emit(EEventType.CommandRejected, commandFailed(commandType, error), undefined, undefined);
    });
  }

  private async find(
    tx: TDatabaseTransaction,
    ownerKey: string,
    id: string,
  ): Promise<TOption<TStoredConnector>> {
    return tx
      .select()
      .from(connectorsTable)
      .where(and(eq(connectorsTable.ownerKey, ownerKey), eq(connectorsTable.id, id)))
      .get();
  }

  private async owned(
    tx: TDatabaseTransaction,
    ownerKey: string,
    id: string,
  ): Promise<TStoredConnector> {
    const row = await this.find(tx, ownerKey, id);

    if (row === undefined) {
      throw new ConnectorRejection(CONNECTOR_NOT_FOUND, `No connector ${id}`);
    }

    return row;
  }

  private async setStatus(
    tx: TDatabaseTransaction,
    ownerKey: string,
    id: string,
    status: EConnectorStatus,
  ): Promise<TOption<TStoredConnector>> {
    const [row] = await tx
      .update(connectorsTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(connectorsTable.ownerKey, ownerKey), eq(connectorsTable.id, id)))
      .returning();
    return row;
  }

  private async delete(tx: TDatabaseTransaction, ownerKey: string, id: string): Promise<void> {
    await tx
      .delete(connectorsTable)
      .where(and(eq(connectorsTable.ownerKey, ownerKey), eq(connectorsTable.id, id)));
  }
}
