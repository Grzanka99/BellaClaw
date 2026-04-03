import { describe, expect, test } from "bun:test";
import { ERole } from "../ai-providers/types";
import { sortByImportanceAndDates } from "./sort";
import type { TMemory } from "./types";
import { EMemoryImportance } from "./types";

function createMemory(overrides: Partial<TMemory>): TMemory {
  return {
    id: 1,
    chatId: "test-chat",
    author: ERole.User,
    importance: EMemoryImportance.Medium,
    message: "test message",
    createdAt: new Date(),
    lastReadAt: new Date(),
    ...overrides,
  };
}

describe("sortByImportanceAndDates", () => {
  test("sorts by importance when it differs", () => {
    const a = createMemory({ importance: EMemoryImportance.High });
    const b = createMemory({ importance: EMemoryImportance.Medium });

    expect(sortByImportanceAndDates(a, b)).toBeLessThan(0);
    expect(sortByImportanceAndDates(b, a)).toBeGreaterThan(0);
  });

  test("sorts by lastReadAt when importance is equal", () => {
    const older = new Date("2024-01-01");
    const newer = new Date("2024-01-02");
    const a = createMemory({ importance: EMemoryImportance.Medium, lastReadAt: newer });
    const b = createMemory({ importance: EMemoryImportance.Medium, lastReadAt: older });

    expect(sortByImportanceAndDates(a, b)).toBeLessThan(0);
    expect(sortByImportanceAndDates(b, a)).toBeGreaterThan(0);
  });

  test("sorts by createdAt when importance and lastReadAt are equal", () => {
    const same = new Date("2024-01-03");
    const older = new Date("2024-01-01");
    const newer = new Date("2024-01-02");
    const a = createMemory({
      importance: EMemoryImportance.Medium,
      lastReadAt: same,
      createdAt: newer,
    });
    const b = createMemory({
      importance: EMemoryImportance.Medium,
      lastReadAt: same,
      createdAt: older,
    });

    expect(sortByImportanceAndDates(a, b)).toBeLessThan(0);
    expect(sortByImportanceAndDates(b, a)).toBeGreaterThan(0);
  });
});
