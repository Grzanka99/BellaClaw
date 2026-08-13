import { describe, expect, test } from "bun:test";
import { normalizeCronContentFields } from "./cron-content";

describe("cron content normalization", () => {
  test("treats empty and whitespace-only fields as absent", () => {
    for (const blank of ["", "   "]) {
      expect(
        normalizeCronContentFields({
          group: blank,
          reminderText: blank,
          reminderPromptData: blank,
          reminderFallbackText: blank,
          taskPrompt: blank,
          taskFallbackText: blank,
        }),
      ).toEqual({
        group: undefined,
        reminderText: undefined,
        reminderPromptData: undefined,
        reminderFallbackText: undefined,
        taskPrompt: undefined,
        taskFallbackText: undefined,
      });
    }
  });

  test("preserves populated fields verbatim", () => {
    expect(
      normalizeCronContentFields({
        group: "home",
        reminderText: " Buy milk ",
        taskPrompt: "",
      }),
    ).toMatchObject({
      group: "home",
      reminderText: " Buy milk ",
      taskPrompt: undefined,
    });
  });
});
