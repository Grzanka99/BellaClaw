import { EEventType } from "@bellaclaw/database";
import { ESubscriptionMode, EventBus } from "../events";
import { getConnector } from "./config";
import { mcpAdapter } from "./mcp";
import type { TConnectorOpenArgs, TConnectorSession } from "./types";

export type { TConnectorOpenArgs, TConnectorSession } from "./types";

export class ConnectorService {
  private static _instance: ConnectorService;
  private sessions = new Map<TConnectorSession, { ownerKey: string; connectorId: string }>();

  public static get instance() {
    if (ConnectorService._instance === undefined) {
      ConnectorService._instance = new ConnectorService();
    }
    return ConnectorService._instance;
  }

  // live: closing sessions must not replay after a restart
  public setup(): void {
    EventBus.instance.subscribe({
      consumer: "mcp-sessions",
      type: EEventType.McpAuthCredentialsChanged,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: (event) => this.disconnect(event.payload.chatId, event.payload.profileId),
    });
  }

  public async open(args: TConnectorOpenArgs): Promise<TConnectorSession> {
    const connector = await getConnector(args.connectorId);
    const session = await mcpAdapter.open(connector, args);
    this.sessions.set(session, { ownerKey: args.ownerKey, connectorId: connector.id });
    session.signal.addEventListener("abort", () => this.sessions.delete(session), { once: true });
    return session;
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
}
