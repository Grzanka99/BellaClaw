import { AutomationService } from "../../../automation";
import { summarizeAutomation } from "../automation-summary";

export async function handleAutomationList(chatId: string) {
  const automations = await AutomationService.instance.list(chatId);

  return automations.map((automation) => summarizeAutomation(automation));
}
