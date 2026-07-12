import { describe, expect, test } from "bun:test";
import { sanitizeToolResultError } from "./sanitizers";

describe("app logger sanitizer errors", () => {
  test("redacts failed cron tool errors", () => {
    const error = sanitizeToolResultError({
      toolCallId: "tool-call-1",
      toolName: "update-cron-job",
      success: false,
      data: undefined,
      error: "No job found with name: private-health-reminder",
    });

    expect(error).toBe("update-cron-job failed");
    expect(error).not.toContain("private-health-reminder");
  });
});
