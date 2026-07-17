import { logger } from "../../utils/logger";
import { createLogViewerApp } from "./app";

const HOSTNAME = "0.0.0.0";
const PORT = 8989;
const application = createLogViewerApp();

Bun.serve({
  fetch: application.app.fetch,
  hostname: HOSTNAME,
  port: PORT,
});

logger.info(`Log viewer listening on http://${HOSTNAME}:${PORT}`);
