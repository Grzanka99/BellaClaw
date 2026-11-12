import { mock } from "bun:test";
import { AppLogger } from "@bellaclaw/behavior-logs";
import "../services/mcp";
import { stopMcpAuthServer } from "../services/mcp/auth";

for (const [path, name] of [
  ["../services/authorization", "AuthorizationService"],
  ["../services/calendar", "CalendarService"],
  ["../services/commands", "Commands"],
  ["../services/discord", "DiscordSingleton"],
  ["../services/messaging", "MessagingAdapter"],
  ["../services/notices", "Notices"],
  ["../services/scheduling/delivery", "ScheduledDelivery"],
  ["../services/signal", "SignalSingleton"],
]) {
  if (path !== undefined && name !== undefined) {
    mock.module(path, () => ({ [name]: { instance: { setup: async () => undefined } } }));
  }
}
mock.module("../services/message-handler", () => ({
  MessageHandler: { instance: { setup: () => undefined } },
}));
mock.module("../services/cron", () => ({
  CronScheduler: { instance: { setup: async () => undefined } },
}));
mock.module("../services/memory/distill", () => ({
  FactDistiller: { instance: { setup: () => undefined } },
}));
mock.module("../services/events", () => ({
  EventBus: {
    instance: {
      start: async () => undefined,
      publish: async () => undefined,
      stop: async () => undefined,
    },
  },
}));
mock.module("../services/mcp/auth", () => ({
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
