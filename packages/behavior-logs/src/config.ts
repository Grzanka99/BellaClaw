import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TBehaviorLogEvent } from "./types";

export const APP_DATA_DIR = "/app-data";
export const DEFAULT_LOG_DB_FILE = "bellaclaw-logs.db";
const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");

export function getDefaultLogDbPath(): string {
  const configuredPath = Bun.env.BELLACLAW_LOG_DB_PATH?.trim();

  if (configuredPath !== undefined && configuredPath.length > 0) {
    if (configuredPath === ":memory:") {
      return configuredPath;
    }

    let resolvedPath = configuredPath;

    if (!isAbsolute(resolvedPath)) {
      resolvedPath = resolve(REPOSITORY_ROOT, resolvedPath);
    }

    const configuredRoot = Bun.env.BELLACLAW_LOG_DB_ROOT?.trim();

    if (configuredRoot !== undefined && configuredRoot.length > 0) {
      let resolvedRoot = configuredRoot;

      if (!isAbsolute(resolvedRoot)) {
        resolvedRoot = resolve(REPOSITORY_ROOT, resolvedRoot);
      }

      const relativePath = relative(resolvedRoot, resolvedPath);

      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new Error(`Behavior log database path must be inside ${configuredRoot}`);
      }
    }

    return resolvedPath;
  }

  if (Bun.env.BELLACLAW_DATABASE_MODE === "test" || Bun.env.NODE_ENV === "test") {
    return ":memory:";
  }

  if (existsSync(APP_DATA_DIR)) {
    return `${APP_DATA_DIR}/${DEFAULT_LOG_DB_FILE}`;
  }

  return resolve(REPOSITORY_ROOT, DEFAULT_LOG_DB_FILE);
}

export function formatBehaviorEventForStdout(event: TBehaviorLogEvent): string {
  return JSON.stringify(event);
}
