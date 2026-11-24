import { logger } from "@bellaclaw/shared";
import { createLogViewerApp } from "./app";

const HOSTNAME = Bun.env.BELLACLAW_LOG_VIEWER_HOSTNAME ?? "127.0.0.1";
const PORT = 8989;
const application = createLogViewerApp();

Bun.serve({
  fetch: application.app.fetch,
  hostname: HOSTNAME,
  port: PORT,
});

logger.info(`Log viewer listening on http://${HOSTNAME}:${PORT}`);

// NOTE: this is its container's main process, which ignores a signal that has no handler: Podman
// would wait out its stop timeout on every restart and update
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => process.exit(0));
}
