import { DiscordSingleton } from "./services/discord";
import { MessagingAdapter } from "./services/messaging";
import { SignalSingleton } from "./services/signal";

async function init(): Promise<void> {
  console.time("init");

  void SignalSingleton.instance.setup();
  await Promise.all([DiscordSingleton.instance.setup(), MessagingAdapter.instance.setup()]);

  console.timeEnd("init");
}

init();
