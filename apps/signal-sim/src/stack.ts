import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { logger, repositoryPath, type TOption } from "@bellaclaw/shared";
import {
  SIM_DB_PORT,
  SIM_HOME,
  SIM_OLLAMA_PORT,
  SIM_PORT,
  SIM_URL,
  SIM_VAULT_PORT,
} from "./config";

export const VAULT_DIR = resolve(SIM_HOME, "vault");
export const VAULT_DATA_DIR = resolve(SIM_HOME, "vault-data");
export const AI_CREDENTIALS_FILE = "pi-auth.json";

const COMPOSE_FILE = repositoryPath("compose.sim.yaml");

// NOTE: resolved values go to every child, so the containers, the sim and the assistant agree
export const SIM_ENV = {
  SIGNAL_SIM_HOME: SIM_HOME,
  SIGNAL_SIM_PORT: String(SIM_PORT),
  SIGNAL_SIM_DB_PORT: String(SIM_DB_PORT),
  SIGNAL_SIM_VAULT_PORT: String(SIM_VAULT_PORT),
  SIGNAL_SIM_OLLAMA_PORT: String(SIM_OLLAMA_PORT),
};

// NOTE: --env-file /dev/null keeps compose from interpolating the repository's production .env
export async function compose(args: string[]): Promise<boolean> {
  const child = Bun.spawn(
    ["podman", "compose", "--env-file", "/dev/null", "-f", COMPOSE_FILE, ...args],
    { env: { ...Bun.env, ...SIM_ENV }, stdio: ["inherit", "inherit", "inherit"] },
  );

  return (await child.exited) === 0;
}

export async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

export async function readVaultToken(): Promise<TOption<string>> {
  const file = Bun.file(resolve(VAULT_DATA_DIR, "local-agent.token"));
  if (!(await file.exists())) {
    return undefined;
  }

  return (await file.text()).trim();
}

async function reset(): Promise<void> {
  if (await answers(SIM_URL)) {
    logger.error(`The sim answers on ${SIM_URL}; stop dev:sim before reset`);
    process.exitCode = 1;
    return;
  }

  if (!(await compose(["down"]))) {
    process.exitCode = 1;
    return;
  }

  // NOTE: the Ollama volume stays, so a reset does not download the embedding model again
  await Bun.spawn(["podman", "volume", "rm", "--force", "bellaclaw-sim-db"], {
    stdio: ["ignore", "ignore", "inherit"],
  }).exited;

  if (!existsSync(SIM_HOME)) {
    return;
  }

  for (const entry of await readdir(SIM_HOME)) {
    if (entry !== AI_CREDENTIALS_FILE) {
      await rm(resolve(SIM_HOME, entry), { recursive: true, force: true });
    }
  }

  logger.info(`Wiped sim state in ${SIM_HOME}, kept the LLM login`);
}

export async function runStackCommand(command: string, _args: string[]): Promise<boolean> {
  if (command === "down") {
    if (!(await compose(["down"]))) {
      process.exitCode = 1;
    }
    return true;
  }

  if (command === "reset") {
    await reset();
    return true;
  }

  if (command === "vault-token") {
    const token = await readVaultToken();
    if (token === undefined) {
      logger.error("No vault token yet; start the stack with bun run dev:sim");
      process.exitCode = 1;
      return true;
    }

    console.log(token);
    return true;
  }

  return false;
}
