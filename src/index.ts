import { DiscordSingleton } from "./services/discord";

async function init(): Promise<void> {
  console.time("init");

  const discord = DiscordSingleton.instance;

  discord.setup();

  console.timeEnd("init");
}

init();
