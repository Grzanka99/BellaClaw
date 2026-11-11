import { homedir } from "node:os";
import { resolve } from "node:path";
import type { TOption } from "@bellaclaw/shared";

function port(value: TOption<string>, fallback: number): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

// NOTE: state lives outside the repository so every worktree and clone shares one login.
function simHome(): string {
  if (Bun.env.SIGNAL_SIM_HOME !== undefined) {
    return resolve(Bun.env.SIGNAL_SIM_HOME);
  }

  return resolve(Bun.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "bellaclaw-sim");
}

export const SIM_HOME = simHome();

export const SIM_PORT = port(Bun.env.SIGNAL_SIM_PORT, 18080);
export const SIM_DB_PORT = port(Bun.env.SIGNAL_SIM_DB_PORT, 18081);
export const SIM_VAULT_PORT = port(Bun.env.SIGNAL_SIM_VAULT_PORT, 18787);
export const SIM_OLLAMA_PORT = port(Bun.env.SIGNAL_SIM_OLLAMA_PORT, 18434);

export const SIM_URL = `http://127.0.0.1:${SIM_PORT}`;
export const SIM_DB_URL = `http://127.0.0.1:${SIM_DB_PORT}`;
export const SIM_VAULT_MCP_URL = `http://127.0.0.1:${SIM_VAULT_PORT}/mcp`;
export const SIM_OLLAMA_URL = `http://127.0.0.1:${SIM_OLLAMA_PORT}`;

export const ASSISTANT_NUMBER = "+10000000000";
export const DEFAULT_USER_NUMBER = "+15550000001";
export const ACTIVATION_TOKEN = "sim-activation-token";

export const SIM_TRANSCRIPT_DB = resolve(SIM_HOME, "sim.db");
export const SIM_ATTACHMENTS_DIR = resolve(SIM_HOME, "attachments");
