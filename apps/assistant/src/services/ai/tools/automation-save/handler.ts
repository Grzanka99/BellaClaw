import { AutomationService } from "../../../automation";
import { summarizeAutomation } from "../automation-summary";
import type { TAutomationSaveArgs } from "./definition";

export async function handleAutomationSave(chatId: string, args: TAutomationSaveArgs) {
  const automation = await AutomationService.instance.saveDraft(chatId, args.previewId);

  return summarizeAutomation(automation);
}
