import { EEventType } from "@bellaclaw/database";
import { arr, int, obj, str } from "@earendil-works/pi-schema";
import { CommandRejectedError } from "../../../events";
import { EMBEDDING_UNAVAILABLE, MEMORY_REQUEST_TIMEOUT_MS } from "../../../memory";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

export const SRememberMemoryArgs = obj({
  fact: str({
    minLength: 1,
    pattern: "\\S",
    description: "One durable fact to remember",
  }),
  sourceMessage: str({
    minLength: 1,
    pattern: "\\S",
    description: "Exact user transcript message that stated the fact",
  }),
  supersedesFactIds: arr(int({ minimum: 1 }), {
    uniqueItems: true,
    description: "Live fact IDs this fact replaces; empty when it replaces none",
  }),
});

export const rememberMemory = defineTool({
  name: "remember-memory",
  label: "Remember memory",
  description: "Store one explicit durable conversation fact.",
  schema: SRememberMemoryArgs,
  instructions,
  mode: "sequential",
  logSafe: [],
  execute: async (context, args) => {
    const chatId = requireChatId(context.chatId);
    const fact = args.fact.trim();
    if (fact.length === 0) {
      throw new Error("Memory fact must not be blank");
    }

    try {
      const remembered = await context.events.request(
        EEventType.MemoryFactRememberRequested,
        {
          chatId,
          text: fact,
          sourceMessage: args.sourceMessage,
          supersedesFactIds: args.supersedesFactIds,
        },
        {
          outcome: EEventType.MemoryFactRemembered,
          step: undefined,
          key: chatId,
          timeoutMs: MEMORY_REQUEST_TIMEOUT_MS,
        },
      );
      return { rememberedFactId: remembered.payload.factId };
    } catch (error) {
      if (error instanceof CommandRejectedError && error.errorCode === EMBEDDING_UNAVAILABLE) {
        throw new Error(error.message);
      }

      throw new Error(`Memory remember failed: ${String(error)}`);
    }
  },
});
