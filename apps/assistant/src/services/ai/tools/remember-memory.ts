import { arr, int, obj, str } from "@earendil-works/pi-schema";
import { EmbeddingClient } from "../../embedding";
import { Memory } from "../../memory";
import { defineTool, requireChatId } from "./define-tool";
import instructions from "./remember-memory.xml" with { type: "text" };

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

    const embedding = await EmbeddingClient.instance.embed(fact);
    if (embedding === undefined) {
      throw new Error("Embedding service unavailable");
    }

    try {
      const remembered = await Memory.instance.rememberFact(
        chatId,
        fact,
        args.sourceMessage,
        embedding,
        args.supersedesFactIds,
      );
      return { rememberedFactId: remembered.id };
    } catch (error) {
      throw new Error(`Memory remember failed: ${String(error)}`);
    }
  },
});
