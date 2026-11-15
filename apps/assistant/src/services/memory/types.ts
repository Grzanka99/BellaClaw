import {
  EMBEDDING_DIMENSIONS,
  type factDistillationStateTable,
  type factsTable,
  type TSelectMemory,
} from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";

export const SPreparedFact = z.object({
  text: z.string(),
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
  sourceMessageId: z.number(),
  supersedesFactIds: z.array(z.number().int().positive()),
});

export type TFact = typeof factsTable.$inferSelect;
export type TPreparedFact = z.infer<typeof SPreparedFact>;

export type TFactSearchResult = Pick<TFact, "id" | "text" | "createdAt" | "sourceMessageId"> & {
  distance: number;
};

export type TFactDistillationState = Omit<
  typeof factDistillationStateTable.$inferSelect,
  "updatedAt"
> & {
  updatedAt: TOption<Date>;
};

export type TFactWindow = {
  context: TSelectMemory[];
  messages: TSelectMemory[];
};

export type TLiveFactWindow = TFactWindow & {
  state: TFactDistillationState;
};

export type TFactCommitArgs = {
  chatId: string;
  expectedLastProcessedMessageId: number;
  lastProcessedMessageId: number;
  facts: TPreparedFact[];
};

export type TFactCommitResult =
  | {
      committed: true;
      facts: TFact[];
    }
  | {
      committed: false;
      reason: "stale-checkpoint";
    };
