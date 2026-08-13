import { EmbeddingClient } from "../../../embedding";
import { Memory } from "../../../memory";
import type { TRememberMemoryArgs } from "./definition";

export async function handleRememberMemory(chatId: string, args: TRememberMemoryArgs) {
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
}
