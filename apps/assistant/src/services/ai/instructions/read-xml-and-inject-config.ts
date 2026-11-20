import { formatCommandList } from "../../commands";
import type { TConfigRecord } from "../../settings/schema";
import { injectConfig } from "./inject-config";

const COMMANDS_PLACEHOLDER = "{{commands}}";

export function readXmlAndInjectConfig(xml: string, config: TConfigRecord): string {
  return injectConfig(xml.replaceAll(COMMANDS_PLACEHOLDER, formatCommandList()), config);
}
