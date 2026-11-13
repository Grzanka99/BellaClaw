import { EEventType } from "@bellaclaw/database";
import { arr, int, obj } from "@earendil-works/pi-schema";
import { MEMORY_REQUEST_TIMEOUT_MS } from "../../../memory";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

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
      const forgotten = await context.events.request(
        EEventType.MemoryFactsForgetRequested,
        { chatId, factIds: args.factIds },
        {
          outcome: EEventType.MemoryFactsForgotten,
          step: undefined,
          key: chatId,
          timeoutMs: MEMORY_REQUEST_TIMEOUT_MS,
        },
      );
      return { forgottenFactIds: forgotten.payload.factIds };
    } catch (error) {
      throw new Error(`Memory forget failed: ${String(error)}`);
    }
  },
});
