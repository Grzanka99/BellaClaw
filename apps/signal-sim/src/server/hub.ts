import { createLogger, type TLogger } from "@bellaclaw/shared";
import type { ServerWebSocket } from "bun";
import type { TranscriptStore } from "./store";

export type TSocketData = { number: string };

// NOTE: holds the assistant's receive sockets and delivers envelopes to them; envelopes sent while
// no socket is connected wait in the store's queue, as Signal holds messages until received.
export class SimHub {
  private logger: TLogger = createLogger("SIM_HUB");
  private sockets = new Set<ServerWebSocket<TSocketData>>();
  private lastTimestamp = 0;

  public constructor(
    public readonly store: TranscriptStore,
    public readonly attachmentsDir: string,
    public readonly account: string,
  ) {}

  public nextTimestamp(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  public connected(): boolean {
    return this.sockets.size > 0;
  }

  public open(socket: ServerWebSocket<TSocketData>) {
    this.sockets.add(socket);
    const queued = this.store.drainQueue();
    this.logger.info(`receive socket connected, delivering ${queued.length} queued envelopes`);
    for (const payload of queued) {
      socket.send(payload);
    }
  }

  public close(socket: ServerWebSocket<TSocketData>) {
    this.sockets.delete(socket);
    this.logger.info("receive socket closed");
  }

  public disconnect(): number {
    const count = this.sockets.size;
    for (const socket of this.sockets) {
      socket.terminate();
    }

    this.sockets.clear();
    return count;
  }

  public deliver(envelope: Record<string, unknown>): { payload: string; delivered: boolean } {
    const payload = JSON.stringify({ envelope, account: this.account });
    return { payload, delivered: this.deliverRaw(payload) };
  }

  public deliverRaw(payload: string): boolean {
    if (this.sockets.size === 0) {
      this.store.enqueue(payload);
      return false;
    }

    for (const socket of this.sockets) {
      socket.send(payload);
    }

    return true;
  }
}
