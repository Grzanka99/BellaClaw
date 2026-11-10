import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { EmbeddingClient } from "../../../embedding";
import { Memory } from "../../../memory";
import { FactDistiller } from "../../../memory/distill";
import type { TFactSearchResult } from "../../../memory/types";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

const DEFAULT_LIMIT = 10;

export const SSearchMemoryArgs = obj({
  query: str({
    minLength: 1,
    maxLength: 120,
    pattern: "\\S",
    description:
      "Short natural-language query naming ONE thing to recall, ideally under ten words. Long multi-topic queries match nothing; issue several searches instead.",
  }),
  limit: opt(
    int({
      minimum: 1,
      maximum: 25,
      description: "Maximum number of facts to return; defaults to 10",
    }),
  ),
});

export const searchMemory = defineTool({
  name: "search-memory",
  label: "Search memory",
  description: "Search stored conversation facts using a natural-language query.",
  schema: SSearchMemoryArgs,
  instructions,
  mode: "parallel",
  logSafe: ["limit"],
  execute: async (context, args) => {
    const chatId = requireChatId(context.chatId);
    await FactDistiller.instance.ensureFactsCurrent(chatId, context.trace);

    const embedding = await EmbeddingClient.instance.embedQuery(args.query);
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
  },
});
