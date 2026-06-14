import { MessagingAdapter } from "./services/messaging";
import { SignalSingleton } from "./services/signal";

async function init(): Promise<void> {
  console.time("init");

  const migrationReady = MessagingAdapter.instance.migrateData();
  const signalReady = SignalSingleton.instance.setup();

  await Promise.all([migrationReady, signalReady]);
  await MessagingAdapter.instance.setup();

  console.timeEnd("init");
}

init();
