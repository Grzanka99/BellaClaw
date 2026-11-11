import { obj } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { summarizeAutomation } from "../automation-summary";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const automationList = defineTool({
  name: "automation-list",
  label: "List automations",
  description: "List the saved automations in this chat with their status and last error.",
  schema: obj({}, { description: "No arguments are required" }),
  instructions,
  mode: "parallel",
  logSafe: [],
  execute: async (context) => {
    const scope = requireChatId(context.chatId);
    const automations = await AutomationService.instance.list(scope);

    return automations.map((automation) => summarizeAutomation(automation));
  },
});
