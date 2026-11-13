import { cp, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { logger, repositoryPath } from "@bellaclaw/shared";
import {
  ACTIVATION_TOKEN,
  ASSISTANT_NUMBER,
  SIM_DB_URL,
  SIM_HOME,
  SIM_OLLAMA_URL,
  SIM_URL,
  SIM_VAULT_MCP_URL,
} from "./config";
import {
  AI_CREDENTIALS_FILE,
  answers,
  compose,
  readVaultToken,
  SIM_ENV,
  VAULT_DATA_DIR,
  VAULT_DIR,
} from "./stack";

// NOTE: keep in sync with DEFAULT_MODEL in apps/assistant/src/services/embedding/index.ts
const EMBEDDING_MODEL = "embeddinggemma-2:270m";
const LOG_VIEWER_URL = "http://127.0.0.1:8989";
const READY_TIMEOUT_MS = 120_000;

// NOTE: every variable the assistant and log viewer read is set here, so production values exported
// by the shell never reach them
const env = {
  ...Bun.env,
  ...SIM_ENV,
  NODE_ENV: "",
  BELLACLAW_DATABASE_MODE: "",
  TURSO_CONNECTION_URL: SIM_DB_URL,
  TURSO_AUTH_TOKEN: "sim",
  DISCORD_TOKEN: "",
  SIGNAL_ENABLED: "true",
  SIGNAL_CLI_RPC_URL: SIM_URL,
  SIGNAL_PHONE_NUMBER: ASSISTANT_NUMBER,
  BELLACLAW_ACTIVATION_TOKEN: ACTIVATION_TOKEN,
  BELLACLAW_AI_CREDENTIALS_PATH: resolve(SIM_HOME, AI_CREDENTIALS_FILE),
  BELLACLAW_MCP_CREDENTIALS_PATH: resolve(SIM_HOME, "mcp-credentials.json"),
  BELLACLAW_MCP_CONFIG: "mcp.json",
  BELLACLAW_MCP_PUBLIC_URL: "",
  BELLACLAW_MCP_AUTH_PORT: "",
  BELLACLAW_VAULT_MCP_URL: SIM_VAULT_MCP_URL,
  BELLACLAW_LOGS_MCP_URL: `${LOG_VIEWER_URL}/mcp`,
  BELLACLAW_EMBEDDING_BASE_URL: SIM_OLLAMA_URL,
  BELLACLAW_EMBEDDING_MODEL: EMBEDDING_MODEL,
  BELLACLAW_LOG_DB_PATH: resolve(SIM_HOME, "bellaclaw-logs.db"),
  BELLACLAW_LOG_DB_ROOT: SIM_HOME,
  BELLACLAW_LOG_VIEWER_HOSTNAME: "127.0.0.1",
  LOG_CHATID_HMAC_KEY: "",
};

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

async function waitFor(name: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      fail(`${name} not ready after ${READY_TIMEOUT_MS / 1000}s`);
    }
    await Bun.sleep(500);
  }
}

async function seedVault(): Promise<void> {
  await mkdir(VAULT_DIR, { recursive: true });
  await mkdir(VAULT_DATA_DIR, { recursive: true });
  if ((await readdir(VAULT_DIR)).length > 0) {
    return;
  }

  await cp(repositoryPath("apps/signal-sim/vault-seed"), VAULT_DIR, { recursive: true });
  logger.info(`Seeded the sim vault in ${VAULT_DIR}`);
}

async function ensureEmbeddingModel(): Promise<void> {
  const show = await fetch(`${SIM_OLLAMA_URL}/api/show`, {
    method: "POST",
    body: JSON.stringify({ model: EMBEDDING_MODEL }),
  });
  if (show.ok) {
    return;
  }

  logger.info(`Embedding model ${EMBEDDING_MODEL} is missing from Ollama; pulling it`);
  const pull = await fetch(`${SIM_OLLAMA_URL}/api/pull`, {
    method: "POST",
    body: JSON.stringify({ model: EMBEDDING_MODEL, stream: false }),
  });
  if (!pull.ok) {
    fail(`Pulling ${EMBEDDING_MODEL} failed: ${pull.status} ${await pull.text()}`);
  }
}

async function migrate(): Promise<void> {
  const child = Bun.spawn(
    ["bun", "--no-env-file", "--bun", repositoryPath("node_modules/.bin/drizzle-kit"), "migrate"],
    { cwd: repositoryPath("packages/database"), env, stdio: ["inherit", "inherit", "inherit"] },
  );
  if ((await child.exited) !== 0) {
    fail("Database migration failed");
  }
}

if (await answers(SIM_URL)) {
  fail(`Something already answers on ${SIM_URL}; is dev:sim running elsewhere?`);
}
if (await answers(LOG_VIEWER_URL)) {
  fail(`Something already answers on ${LOG_VIEWER_URL}; the sim log viewer needs that port`);
}

await mkdir(SIM_HOME, { recursive: true });
await seedVault();
if (!(await compose(["up", "-d"]))) {
  fail("Starting the sim containers failed");
}
await waitFor("Sim database", async () => {
  try {
    return (await fetch(`${SIM_DB_URL}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
});
await waitFor("Sim vault", async () => {
  return (await readVaultToken()) !== undefined && (await answers(SIM_VAULT_MCP_URL));
});
await waitFor("Sim Ollama", () => answers(`${SIM_OLLAMA_URL}/api/version`));
await ensureEmbeddingModel();
await migrate();

const children = ["signal-sim", "log-viewer", "assistant"].map((app) =>
  Bun.spawn(["bun", "--no-env-file", "run", "--watch", "src/index.ts"], {
    cwd: repositoryPath("apps", app),
    env,
    stdio: ["inherit", "inherit", "inherit"],
  }),
);

async function stop(code: number): Promise<never> {
  for (const child of children) {
    child.kill();
  }
  await Promise.all(children.map((child) => child.exited));
  logger.info("Stopped; containers are still up (bun run sim down stops them)");
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const first = await Promise.race(children.map((child) => child.exited.then(() => child)));
// NOTE: Ctrl-C reaches the children too, and one may exit before our own SIGINT handler runs
if (first.signalCode === "SIGINT") {
  await stop(0);
}
logger.error("A sim process exited; stopping the rest");
await stop(1);
