import { createLogViewerApp } from "./app";
import { logger } from "./logger";

const HOSTNAME = Bun.env.BELLACLAW_LOG_VIEWER_HOSTNAME ?? "127.0.0.1";
const PORT = 8989;
const application = createLogViewerApp();

Bun.serve({
  fetch: application.app.fetch,
  hostname: HOSTNAME,
  port: PORT,
});

logger.info(`Log viewer listening on http://${HOSTNAME}:${PORT}`);
