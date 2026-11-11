import { createLogger } from "@bellaclaw/shared";
import type { Server } from "bun";
import { handleControlApi } from "./control-api";
import { SimHub, type TSocketData } from "./hub";
import { handleSignalApi } from "./signal-api";
import { TranscriptStore } from "./store";

export type TSimServerOptions = {
  hostname: string;
  port: number;
  transcriptDb: string;
  attachmentsDir: string;
  account: string;
};

export type TSimServer = {
  server: Server<TSocketData>;
  hub: SimHub;
  stop: () => Promise<void>;
};

const logger = createLogger("SIGNAL_SIM");

export function startSimServer(options: TSimServerOptions): TSimServer {
  const store = new TranscriptStore(options.transcriptDb);
  const hub = new SimHub(store, options.attachmentsDir, options.account);

  const server = Bun.serve<TSocketData>({
    hostname: options.hostname,
    port: options.port,
    async fetch(request, server) {
      // NOTE: a web page the developer visits can reach this port. Browsers put Origin on those
      // requests, and a DNS-rebound page arrives under its own Host.
      const host = request.headers.get("host");
      if (
        request.headers.has("origin") ||
        (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`)
      ) {
        return new Response("forbidden\n", { status: 403 });
      }

      const url = new URL(request.url);
      if (url.pathname.startsWith("/sim/")) {
        return handleControlApi(hub, request);
      }

      const receive = /^\/v1\/receive\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && receive?.[1] !== undefined) {
        const number = decodeURIComponent(receive[1]);
        if (server.upgrade(request, { data: { number } })) {
          return undefined;
        }

        // NOTE: gorilla's Upgrader answers a non-websocket request with http.Error("Bad Request").
        return new Response("Bad Request\n", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      return handleSignalApi(hub, request);
    },
    websocket: {
      // NOTE: signal-cli-rest-api only forwards envelopes whose account matches the path number;
      // a socket for any other number stays open and silent.
      open(socket) {
        if (socket.data.number === hub.account) {
          hub.open(socket);
        }
      },
      message() {},
      close(socket) {
        if (socket.data.number === hub.account) {
          hub.close(socket);
        }
      },
    },
  });

  logger.info(`listening on http://${options.hostname}:${server.port} as ${options.account}`);

  return {
    server,
    hub,
    stop: async () => {
      await server.stop(true);
      store.close();
    },
  };
}
