import { arr, int, obj } from "@earendil-works/pi-schema";
import { Memory } from "../../memory";
import { defineTool, requireChatId } from "./define-tool";
import instructions from "./forget-memory.xml" with { type: "text" };

export const SForgetMemoryArgs = obj({
  factIds: arr(int({ minimum: 1 }), {
    minItems: 1,
    uniqueItems: true,
    description: "Unique IDs of the resolved live facts to forget",
  }),
});

export const forgetMemory = defineTool({
  name: "forget-memory",
  label: "Forget memory",
  description: "Forget one or more resolved live conversation facts.",
  schema: SForgetMemoryArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  execute: async (context, args) => {
    const chatId = requireChatId(context.chatId);
    try {
      return { forgottenFactIds: await Memory.instance.forgetFacts(chatId, args.factIds) };
    } catch (error) {
      throw new Error(`Memory forget failed: ${String(error)}`);
    }
  },
});
