import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TBehaviorLogEvent } from "./types";

export const APP_DATA_DIR = "/app-data";
export const DEFAULT_LOG_DB_FILE = "bellaclaw-logs.db";

export function getDefaultLogDbPath(): string {
  const configuredPath = Bun.env.BELLACLAW_LOG_DB_PATH?.trim();

  if (configuredPath !== undefined && configuredPath.length > 0) {
    const configuredRoot = Bun.env.BELLACLAW_LOG_DB_ROOT?.trim();

    if (configuredRoot !== undefined && configuredRoot.length > 0) {
      const relativePath = relative(resolve(configuredRoot), resolve(configuredPath));

      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new Error(`Behavior log database path must be inside ${configuredRoot}`);
      }
    }

    return configuredPath;
  }

  if (Bun.env.BELLACLAW_DATABASE_MODE === "test" || Bun.env.NODE_ENV === "test") {
    return ":memory:";
  }

  if (existsSync(APP_DATA_DIR)) {
    return `${APP_DATA_DIR}/${DEFAULT_LOG_DB_FILE}`;
  }

  return `./${DEFAULT_LOG_DB_FILE}`;
}

export function formatBehaviorEventForStdout(event: TBehaviorLogEvent): string {
  return JSON.stringify(event);
}
