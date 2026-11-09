import { AutomationService } from "../../../automation";
import { summarizeAutomation } from "../automation-summary";
import type { TAutomationSetStatusArgs } from "./definition";

export async function handleAutomationSetStatus(chatId: string, args: TAutomationSetStatusArgs) {
  const automation = await AutomationService.instance.setStatus(chatId, args.name, args.status);

  return summarizeAutomation(automation);
}
