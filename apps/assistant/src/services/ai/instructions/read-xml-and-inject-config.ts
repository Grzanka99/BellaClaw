import type { TConfig } from "../../../config";
import type { TConfigRecord } from "../../settings/schema";

const PLACEHOLDER_PATTERN = /\{\{config\.([a-zA-Z0-9._]+)\}\}/g;
const MAX_RESOLUTION_PASSES = 10;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(config: unknown, path: string): string {
  if (isPlainRecord(config)) {
    const direct = config[path];

    if (typeof direct === "string") {
      return direct;
    }
  }

  const keys = path.split(".");
  let current: unknown = config;

  for (const key of keys) {
    if (!isPlainRecord(current)) {
      throw new Error(
        `readXmlAndInjectConfig: cannot resolve "config.${path}" — "${key}" hit a non-object value`,
      );
    }

    current = current[key];
  }

  if (current === undefined) {
    throw new Error(`readXmlAndInjectConfig: "config.${path}" is undefined`);
  }

  return String(current);
}

export async function readXmlAndInjectConfig(
  path: string,
  config: TConfig | TConfigRecord,
): Promise<string> {
  const xml = await Bun.file(path).text();

  let result = xml;

  for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass++) {
    const nextResult = result.replace(PLACEHOLDER_PATTERN, (_match, pathStr: string) => {
      return resolveConfigPath(config, pathStr);
    });

    if (nextResult === result) {
      return result;
    }

    result = nextResult;
  }

  return result;
}
