import { AutomationService } from "../../../automation";
import type { TAutomationDeleteArgs } from "./definition";

export async function handleAutomationDelete(chatId: string, args: TAutomationDeleteArgs) {
  const result = await AutomationService.instance.delete(chatId, args.name);

  return {
    name: result.automation.name,
    updatedJobs: result.updatedJobs,
    cancelledJobs: result.cancelledJobs,
  };
}
