import { z } from "zod";
import { ERole } from "../ai/types";
import { EMBEDDING_DIMENSIONS } from "../database/schema";

export enum EMemoryImportance {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export const SMemory = z.object({
  id: z.number(),
  chatId: z.string(),
  author: z.enum(ERole),
  importance: z.enum(EMemoryImportance),
  message: z.string(),
  createdAt: z.coerce.date(),
  lastReadAt: z.coerce.date(),
});

export const SSaveArgs = SMemory.omit({ id: true, createdAt: true, lastReadAt: true });

export type TMemory = z.infer<typeof SMemory>;
export type TSaveArgs = z.infer<typeof SSaveArgs>;

const SFactEmbedding = z.array(z.number()).length(EMBEDDING_DIMENSIONS);
const SOptionalFactId = z
  .number()
  .nullable()
  .transform((value) => {
    if (value === null) {
      return undefined;
    }

    return value;
  });

export const SFact = z.object({
  id: z.number(),
  chatId: z.string(),
  text: z.string(),
  embedding: SFactEmbedding,
  createdAt: z.coerce.date(),
  supersededBy: SOptionalFactId,
  sourceMessageId: z.number(),
});

export const SPreparedFact = SFact.omit({
  id: true,
  chatId: true,
  createdAt: true,
  supersededBy: true,
}).extend({
  supersedesFactIds: z.array(z.number().int().positive()),
});

export type TFact = z.infer<typeof SFact>;
export type TPreparedFact = z.infer<typeof SPreparedFact>;

export const SFactSearchResult = SFact.pick({
  id: true,
  text: true,
  createdAt: true,
  sourceMessageId: true,
}).extend({
  distance: z.number(),
});

export type TFactSearchResult = z.infer<typeof SFactSearchResult>;

export const SFactDistillationState = z.object({
  chatId: z.string(),
  lastProcessedMessageId: z.number(),
  updatedAt: z.coerce.date().optional(),
});

export type TFactDistillationState = z.infer<typeof SFactDistillationState>;

export type TFactWindow = {
  context: TMemory[];
  messages: TMemory[];
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
