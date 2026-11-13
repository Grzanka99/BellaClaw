import { int, obj } from "@earendil-works/pi-schema";
import { EEventType } from "../../../events/catalog";
import { runAutomationOperation } from "../automation-errors";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const automationSave = defineTool({
  name: "automation-save",
  label: "Save automation",
  description:
    "Save a previewed automation exactly as it was previewed. Only after the user confirmed that preview's result.",
  schema: obj({
    previewId: int({
      minimum: 1,
      description: "previewId of the successful preview whose result the user confirmed",
    }),
  }),
  instructions,
  mode: "sequential",
  privateErrors: true,
  logSafe: ["status", "failureCount", "outputCapBytes"],
  execute: async (context, args) => {
    const scope = requireChatId(context.chatId);
    const saved = await runAutomationOperation(() =>
      context.events.request(
        EEventType.AutomationSaveRequested,
        { scope, previewId: args.previewId },
        { outcome: EEventType.AutomationSaved, step: undefined, key: scope, timeoutMs: undefined },
      ),
    );

    return saved.payload.automation;
  },
});
