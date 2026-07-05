import { DiscordSingleton } from "./services/discord";
import { MessagingAdapter } from "./services/messaging";
import { SignalSingleton } from "./services/signal";

async function init(): Promise<void> {
  console.time("init");

  await Promise.all([DiscordSingleton.instance.setup(), SignalSingleton.instance.setup()]);
  await MessagingAdapter.instance.setup();

  console.timeEnd("init");
}

init();
