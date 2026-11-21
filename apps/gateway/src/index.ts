import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger, MAX_IMAGE_BYTES, repositoryPath } from "@bellaclaw/shared";
import { AccountStore } from "./account-store";
import { createApp } from "./app";
import { createChatReader } from "./chat-reader";
import { createInternalApi } from "./internal-api";
import { importAccountChats } from "./link-import";
import { createLiveStream } from "./live-stream";

const PAGE_PATH = "/index.html";
const LINK_IMPORT_WAIT_MS = 5_000;
const STREAM_RETRY_MS = 2_000;
// a little over two keep-alive intervals of the assistant's stream (25 s, in its internal API)
const STREAM_SILENCE_MS = 60_000;

const logger = createLogger("GATEWAY");

function requireEnv(name: string): string {
  const value = Bun.env[name]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// The client's page and assets by URL path, bundled in memory. Asset names carry a content hash.
async function buildClient(): Promise<Map<string, Blob>> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "client", "index.html")],
    minify: true,
    splitting: true,
    // absolute asset URLs, so the page works on any path
    publicPath: "/",
  });

  // an output path is relative: ./index.html
  return new Map(build.outputs.map((output) => [output.path.slice(1), output]));
}

const publicUrl = Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL?.trim();
const secret = Bun.env.BELLACLAW_GATEWAY_SECRET?.trim();

// NOTE: the root `start` and `dev` scripts run every app, and the assistant reads the same two
// variables as "gateway disabled". So this is a clean exit, not an error.
if (!publicUrl || !secret) {
  logger.info(
    "Gateway is not configured: BELLACLAW_GATEWAY_PUBLIC_URL or BELLACLAW_GATEWAY_SECRET is unset",
  );
  process.exit(0);
}

if (!URL.canParse(publicUrl)) {
  throw new Error("BELLACLAW_GATEWAY_PUBLIC_URL must be a URL");
}

const hostname = Bun.env.BELLACLAW_GATEWAY_HOSTNAME?.trim() || "127.0.0.1";
const port = Number(Bun.env.BELLACLAW_GATEWAY_PORT?.trim() || 8988);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("BELLACLAW_GATEWAY_PORT must be an integer from 1 to 65535");
}

const internalApiUrl = Bun.env.BELLACLAW_INTERNAL_API_URL?.trim() || "http://127.0.0.1:3081";
const databasePath =
  Bun.env.BELLACLAW_GATEWAY_DB_PATH?.trim() || repositoryPath(".data", "dashboard.db");
const reader = createChatReader(requireEnv("TURSO_CONNECTION_URL"), requireEnv("TURSO_AUTH_TOKEN"));

mkdirSync(dirname(databasePath), { recursive: true });

let client = await buildClient();
const store = new AccountStore(databasePath);
const internalApi = createInternalApi(internalApiUrl.replace(/\/+$/, ""), secret);
const liveStream = createLiveStream(internalApi, STREAM_RETRY_MS, STREAM_SILENCE_MS);

const app = createApp({
  config: { publicOrigin: new URL(publicUrl).origin, secret },
  store,
  reader,
  internalApi,
  liveStream,
  serveClient: async (request) => {
    const path = new URL(request.url).pathname;
    const asset = client.get(path);

    if (asset !== undefined && path !== PAGE_PATH) {
      return new Response(asset, {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    // `bun run dev` bundles again for every page load, so a refresh shows client edits
    if (Bun.env.NODE_ENV === "development") {
      client = await buildClient();
    }

    return new Response(client.get(PAGE_PATH), { headers: { "Cache-Control": "no-cache" } });
  },
});

const server = Bun.serve({
  hostname,
  port,
  // an image upload; every other body is held to 64 KiB by the app
  maxRequestBodySize: MAX_IMAGE_BYTES,
  // NOTE: the maximum. A model change waits for the assistant's provider verification, far beyond
  // the default 10 s.
  idleTimeout: 255,
  fetch: app.fetch,
});

logger.info(`Gateway listening on http://${hostname}:${server.port}`);

// the process ends with the server, so the stream from the assistant is never closed
void liveStream.follow(new AbortController().signal);

// links every row of account_chats through the assistant, then drops the table
void importAccountChats(store, internalApi, LINK_IMPORT_WAIT_MS).catch((error) => {
  logger.error(`Link import stopped: ${error}`);
});
