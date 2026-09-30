import { mock } from "bun:test";
import { AppLogger } from "@bellaclaw/behavior-logs";
import "../services/mcp";
import { stopMcpAuthServer } from "../services/mcp/auth";

for (const [path, name] of [
  ["../services/authorization", "AuthorizationService"],
  ["../services/calendar", "CalendarService"],
  ["../services/discord", "DiscordSingleton"],
  ["../services/messaging", "MessagingAdapter"],
  ["../services/signal", "SignalSingleton"],
]) {
  if (path !== undefined && name !== undefined) {
    mock.module(path, () => ({ [name]: { instance: { setup: async () => undefined } } }));
  }
}
mock.module("../services/message-handler", () => ({
  MessageHandler: { scheduleFactDrainForAllChats: async () => undefined },
}));
mock.module("../services/mcp/auth", () => ({
  registerMcpAuthConnectedListener: () => undefined,
  startMcpAuthServer: () => undefined,
  stopMcpAuthServer,
}));

const booted = Promise.withResolvers<void>();
const appLogger = new AppLogger({
  dbPath: Bun.argv[2],
  stdout(event) {
    if (event.event === "app.boot.complete") {
      booted.resolve();
    }
  },
});
Object.assign(AppLogger, { _instance: appLogger });
await import("../index");
await booted.promise;
for (let sequence = 0; sequence < 8; sequence += 1) {
  appLogger.record({
    trace: { turnId: "shutdown-regression", chatId: undefined, platform: undefined },
    event: "shutdown.regression",
    component: "app",
    metadata: { sequence },
  });
}
process.emit(Bun.argv[3] ?? "SIGTERM");
