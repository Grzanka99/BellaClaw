import { MessagingAdapter } from "./services/messaging";
import { SignalSingleton } from "./services/signal";

async function init(): Promise<void> {
  console.time("init");

  await MessagingAdapter.instance.migrateData();
  await SignalSingleton.instance.setup();
  await MessagingAdapter.instance.setup();

  console.timeEnd("init");
}

init();
