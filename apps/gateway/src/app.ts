import { createLogger } from "@bellaclaw/shared";
import { Hono } from "hono";
import type { TApiError } from "./api-types";
import { registerAuthRoutes } from "./auth-routes";
import { registerConversationRoutes } from "./conversation-routes";
import {
  isAppRequest,
  MAX_JSON_BODY_BYTES,
  type TEnv,
  type TGatewayDependencies,
} from "./route-support";
import { registerStreamRoute } from "./stream-route";

const MEDIA_UPLOAD_PATH = /^\/api\/conversations\/[^/]+\/media$/;

const logger = createLogger("GATEWAY");

export function createApp(dependencies: TGatewayDependencies) {
  const { config, serveClient } = dependencies;
  const app = new Hono<TEnv>();

  app.use(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    // the link token sits in the URL of the page
    c.header("Referrer-Policy", "no-referrer");
  });

  app.use(async (c, next) => {
    const reads = c.req.method === "GET" || c.req.method === "HEAD";

    if (!reads && !isAppRequest(c) && c.req.header("Origin") !== config.publicOrigin) {
      return c.json<TApiError>({ error: "Forbidden" }, 403);
    }

    await next();
  });

  // NOTE: the server takes a body as large as an image, for the upload
  app.use(async (c, next) => {
    const upload = c.req.method === "POST" && MEDIA_UPLOAD_PATH.test(c.req.path);

    if (!upload && Number(c.req.header("Content-Length")) > MAX_JSON_BODY_BYTES) {
      return c.json<TApiError>({ error: "Request body too large" }, 413);
    }

    await next();
  });

  app.onError((error, c) => {
    logger.error(`${c.req.method} request failed: ${error}`);

    return c.json<TApiError>({ error: "Internal error" }, 500);
  });

  registerAuthRoutes(app, dependencies);
  registerConversationRoutes(app, dependencies);
  registerStreamRoute(app, dependencies);

  app.all("/api/*", (c) => c.json<TApiError>({ error: "Not found" }, 404));

  // every other path is the single-page client
  app.get("*", (c) => serveClient(c.req.raw));

  return app;
}
