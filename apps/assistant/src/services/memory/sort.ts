import { EMemoryImportance, type TMemory } from "./types";

const importanceRank: Record<EMemoryImportance, number> = {
  [EMemoryImportance.Low]: 0,
  [EMemoryImportance.Medium]: 1,
  [EMemoryImportance.High]: 2,
};

export function sortByImportanceAndDates(a: TMemory, b: TMemory) {
  if (a.importance !== b.importance) {
    return importanceRank[b.importance] - importanceRank[a.importance];
  }

  if (a.lastReadAt.getTime() !== b.lastReadAt.getTime()) {
    return b.lastReadAt.getTime() - a.lastReadAt.getTime();
  }

  return b.createdAt.getTime() - a.createdAt.getTime();
}
