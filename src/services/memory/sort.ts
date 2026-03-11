import type { TMemory } from "./types";

export function sortByImportanceAndDates(a: TMemory, b: TMemory) {
  if (a.importance !== b.importance) {
    return b.importance - a.importance;
  }

  if (a.lastReadAt.getTime() !== b.lastReadAt.getTime()) {
    return b.lastReadAt.getTime() - a.lastReadAt.getTime();
  }

  return b.createdAt.getTime() - a.createdAt.getTime();
}
