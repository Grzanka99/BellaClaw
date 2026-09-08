import { formatCommandList } from "../../messaging/commands";
import { isConfigKey, type TConfigRecord } from "../../settings/schema";

const PLACEHOLDER_PATTERN = /\{\{config\.([a-zA-Z0-9._]+)\}\}/g;
const COMMANDS_PLACEHOLDER = "{{commands}}";
const MAX_RESOLUTION_PASSES = 10;

export async function readXmlAndInjectConfig(path: string, config: TConfigRecord): Promise<string> {
  const xml = await Bun.file(path).text();

  let result = xml.replaceAll(COMMANDS_PLACEHOLDER, formatCommandList());

  for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass++) {
    const nextResult = result.replace(PLACEHOLDER_PATTERN, (_match, pathStr: string) => {
      if (!isConfigKey(pathStr)) {
        throw new Error(`readXmlAndInjectConfig: unknown config key "${pathStr}"`);
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
