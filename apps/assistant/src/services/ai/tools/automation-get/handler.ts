import type { TOption } from "@bellaclaw/shared";
import { AutomationService } from "../../../automation";
import { summarizeAutomation } from "../automation-summary";
import type { TAutomationGetArgs } from "./definition";

export async function handleAutomationGet(chatId: string, args: TAutomationGetArgs) {
  const automation = await AutomationService.instance.get(chatId, args.name);

  if (automation === undefined) {
    throw new Error(`Automation '${args.name}' not found`);
  }

  let source: TOption<string>;

  if (args.includeSource === true) {
    source = automation.source;
  }

  return {
    ...summarizeAutomation(automation),
    config: automation.config,
    state: automation.state,
    updatedAt: automation.updatedAt,
    source,
  };
}
