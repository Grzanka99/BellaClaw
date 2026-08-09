import { EmbeddingClient } from "../../../embedding";
import { Memory } from "../../../memory";
import type { TFactSearchResult } from "../../../memory/types";
import type { TSearchMemoryArgs } from "./definition";

const DEFAULT_LIMIT = 10;

type TSearchMemoryResult = {
  facts: TFactSearchResult[];
};

export async function handleSearchMemory(
  chatId: string,
  args: TSearchMemoryArgs,
): Promise<TSearchMemoryResult> {
  const embedding = await EmbeddingClient.instance.embed(args.query);
  if (embedding === undefined) {
    throw new Error("Embedding service unavailable");
  }

  let facts: TFactSearchResult[];
  try {
    facts = await Memory.instance.searchFacts(chatId, embedding, args.limit ?? DEFAULT_LIMIT);
  } catch (error) {
    throw new Error(`Memory search failed: ${String(error)}`);
  }

  return { facts };
}
