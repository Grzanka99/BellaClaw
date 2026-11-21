import { isConfigKey, type TConfigRecord } from "../../settings/schema";

const PLACEHOLDER_PATTERN = /\{\{config\.([a-zA-Z0-9._]+)\}\}/g;
const MAX_RESOLUTION_PASSES = 10;

// Resolves the {{config.*}} placeholders, nested ones included, and leaves every other text as
// written. Throws on a placeholder that names no config key
export function injectConfig(text: string, config: TConfigRecord): string {
  let result = text;

  for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass++) {
    const nextResult = result.replace(PLACEHOLDER_PATTERN, (_match, pathStr: string) => {
      if (!isConfigKey(pathStr)) {
        throw new Error(`unknown config key in placeholder "{{config.${pathStr}}}"`);
      }
      return config[pathStr];
    });

    if (nextResult === result) {
      return result;
    }

    result = nextResult;
  }

  return result;
}
