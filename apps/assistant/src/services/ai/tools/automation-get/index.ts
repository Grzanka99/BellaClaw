import type { TOption } from "@bellaclaw/shared";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { AutomationService } from "../../../automation";
import { summarizeAutomation } from "../automation-summary";
import { defineTool, requireChatId, ToolError } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SAutomationGetArgs = obj({
  name: str({ minLength: 1, description: "Exact name of the saved automation" }),
  includeSource: opt(
    bool({ description: "Include the script source; only when editing or fixing the automation" }),
  ),
});

export const automationGet = defineTool({
  name: "automation-get",
  label: "Get automation",
  description:
    "Read one saved automation's details, including config and state; the source only when includeSource is true.",
  schema: SAutomationGetArgs,
  instructions,
  mode: "parallel",
  privateErrors: true,
  logSafe: ["status", "failureCount", "outputCapBytes"],
  execute: async (context, args) => {
    const scope = requireChatId(context.chatId);
    const automation = await AutomationService.instance.get(scope, args.name);

    if (automation === undefined) {
      throw new ToolError("automation-not-found", `Automation '${args.name}' not found`);
    }

    let source: TOption<string>;

    if (args.includeSource === true) {
      source = automation.source;
    }

    return {
      ...summarizeAutomation(automation),
      config: automation.config,
      state: automation.state ?? undefined,
      updatedAt: automation.updatedAt,
      source,
    };
  },
});
