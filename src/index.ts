import { DiscordSingleton } from "./services/discord";
import { MessagingAdapter } from "./services/messaging";
import { SignalSingleton } from "./services/signal";

async function init(): Promise<void> {
  console.time("init");

  await MessagingAdapter.instance.setup();
  await SignalSingleton.instance.setup();
  await DiscordSingleton.instance.setup();

  console.timeEnd("init");
}

init();
