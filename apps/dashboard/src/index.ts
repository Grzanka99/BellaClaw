import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger, repositoryPath } from "@bellaclaw/shared";
import { AccountStore } from "./account-store";
import { createApp } from "./app";
import { createChatReader } from "./chat-reader";
import { createInternalApi } from "./internal-api";

const PAGE_PATH = "/index.html";

const logger = createLogger("DASHBOARD");

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

const publicUrl = Bun.env.BELLACLAW_DASHBOARD_PUBLIC_URL?.trim();
const secret = Bun.env.BELLACLAW_DASHBOARD_SECRET?.trim();

// NOTE: the root `start` and `dev` scripts run every app, and the assistant reads the same two
// variables as "dashboard disabled". So this is a clean exit, not an error.
if (!publicUrl || !secret) {
  logger.info(
    "Dashboard is not configured: BELLACLAW_DASHBOARD_PUBLIC_URL or BELLACLAW_DASHBOARD_SECRET is unset",
  );
  process.exit(0);
}

if (!URL.canParse(publicUrl)) {
  throw new Error("BELLACLAW_DASHBOARD_PUBLIC_URL must be a URL");
}

const port = Number(Bun.env.BELLACLAW_DASHBOARD_PORT?.trim() || 8988);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("BELLACLAW_DASHBOARD_PORT must be an integer from 1 to 65535");
}

const internalApiUrl = Bun.env.BELLACLAW_INTERNAL_API_URL?.trim() || "http://127.0.0.1:3081";
const databasePath =
  Bun.env.BELLACLAW_DASHBOARD_DB_PATH?.trim() || repositoryPath(".data", "dashboard.db");
const reader = createChatReader(requireEnv("TURSO_CONNECTION_URL"), requireEnv("TURSO_AUTH_TOKEN"));

mkdirSync(dirname(databasePath), { recursive: true });

let client = await buildClient();

const app = createApp({
  config: { publicOrigin: new URL(publicUrl).origin, secret },
  store: new AccountStore(databasePath),
  reader,
  internalApi: createInternalApi(internalApiUrl.replace(/\/+$/, ""), secret),
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
  port,
  // NOTE: the maximum. A model change waits for the assistant's provider verification, far beyond
  // the default 10 s.
  idleTimeout: 255,
  fetch: app.fetch,
});

logger.info(`Dashboard listening on port ${server.port}`);
