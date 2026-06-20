import { MessagingAdapter } from "./services/messaging";
import { SettingsService } from "./services/settings";
import { SignalSingleton } from "./services/signal";

async function init(): Promise<void> {
  console.time("init");

  await SettingsService.instance.setup();
  await MessagingAdapter.instance.setup();
  await SignalSingleton.instance.setup();

  console.timeEnd("init");
}

init();
