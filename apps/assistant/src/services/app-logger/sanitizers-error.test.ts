import { afterEach, describe, expect, test } from "bun:test";
import {
  registerRedactedSecret,
  sanitizeErrorMessage,
  sanitizeToolResultError,
} from "./sanitizers";

const originalOpenrouterApiKey = Bun.env.OPENROUTER_API_KEY;

function restoreEnv(name: "OPENROUTER_API_KEY", value: string | undefined) {
  if (value === undefined) {
    delete Bun.env[name];
    return;
  }

  Bun.env[name] = value;
}

describe("app logger sanitizer errors", () => {
  afterEach(() => {
    restoreEnv("OPENROUTER_API_KEY", originalOpenrouterApiKey);
  });

  test("redacts failed cron tool errors", () => {
    const error = sanitizeToolResultError({
      toolCallId: "tool-call-1",
      toolName: "update-cron-job",
      success: false,
      data: undefined,
      error: "No job found with name: private-health-reminder",
    });

    expect(error).toBe("update-cron-job failed: job-not-found");
    expect(error).not.toContain("private-health-reminder");
  });

  test("logs a fixed code for pre-execution cron validation failures", () => {
    const error = sanitizeToolResultError({
      toolCallId: "tool-call-1",
      toolName: "update-cron-job",
      success: false,
      data: undefined,
      error:
        'Validation failed for tool "update-cron-job":\n  - fireAt: invalid\n\nReceived arguments:\n{"reminderText":"private note"}',
    });

    expect(error).toBe("update-cron-job failed: invalid-arguments");
  });

  test("maps each known cron error to its code without private values", () => {
    for (const [message, code] of [
      ["cancel failed: No job found with name: private-job", "job-not-found"],
      ["Provide either pattern or fireAt, not both", "conflicting-schedule-fields"],
      ["Provide reminderText, reminderPromptData, or taskPrompt", "missing-content"],
      [
        "Provide only one of reminderText, reminderPromptData, or taskPrompt",
        "conflicting-content-modes",
      ],
      [
        "reminderFallbackText is required when reminderPromptData is set",
        "invalid-fallback-pairing",
      ],
      ["taskFallbackText requires taskPrompt", "invalid-fallback-pairing"],
      [
        "automations can only be combined with taskPrompt, not with reminders",
        "automations-without-task",
      ],
      ["Unknown automations: private-automation", "unknown-automation"],
      ["Nothing to preview: provide automations or a taskPrompt", "missing-content"],
      ["Invalid fireAt: private-job", "invalid-fire-at"],
      ["fireAt must be local time, YYYY-MM-DDTHH:mm[:ss], with no Z or offset", "invalid-fire-at"],
      ["fireAt can only update one-time reminders; omit fireAt", "fire-at-on-recurring-job"],
      ["fireAt 2027-03-28T02:30:00 does not exist in Europe/Warsaw", "nonexistent-fire-at"],
      ["pattern can only update recurring reminders; omit pattern", "pattern-on-one-time-job"],
      ["create failed: fireAt must be in the future", "fire-at-in-past"],
      [
        "create failed: Job 'private-job' already exists. Set overwrite: true",
        "job-already-exists",
      ],
      ["create failed: Cron pattern '0 0 31 2 *' cannot be scheduled", "unschedulable-pattern"],
      ["create failed: Job 'private-job' is no longer active.", "create-failed"],
      ["cancel failed: Error: private-job", "cancel-failed"],
    ] as const) {
      const error = sanitizeToolResultError({
        toolCallId: "tool-call-1",
        toolName: "update-cron-job",
        success: false,
        data: undefined,
        error: message,
      });

      expect(error).toBe(`update-cron-job failed: ${code}`);
    }
  });

  test("drops unknown cron tool errors", () => {
    const error = sanitizeToolResultError({
      toolCallId: "tool-call-1",
      toolName: "schedule-once",
      success: false,
      data: undefined,
      error: "private-health-reminder exploded",
    });

    expect(error).toBe("schedule-once failed");
  });

  test("redacts configured provider API keys and stored OAuth tokens from errors", () => {
    Bun.env.OPENROUTER_API_KEY = "openrouter-secret-key";
    registerRedactedSecret("opencode-secret-token");

    const error = sanitizeErrorMessage(
      "OpenRouter openrouter-secret-key failed; OpenCode opencode-secret-token failed",
    );

    expect(error).toBe("OpenRouter [REDACTED] failed; OpenCode [REDACTED] failed");
    expect(error).not.toContain("openrouter-secret-key");
    expect(error).not.toContain("opencode-secret-token");
  });

  test("masks a secret that contains another registered secret whole", () => {
    registerRedactedSecret("short-token");
    registerRedactedSecret("short-token-with-suffix");

    expect(sanitizeErrorMessage("failed with short-token-with-suffix")).toBe(
      "failed with [REDACTED]",
    );
  });

  test("drops raw provider payload and reasoning metadata from HTTP errors", () => {
    const directError = sanitizeErrorMessage(
      '400: {"message":"invalid request","metadata":{"raw":"private prompt","reasoning":"private reasoning"}}',
    );
    const namedError = sanitizeErrorMessage(
      'OpenCode Go (502): {"message":"upstream failed","raw":"private response body"}',
    );
    const serialized = JSON.stringify({ directError, namedError });

    expect(directError).toBe("Provider error status=400");
    expect(namedError).toBe("Provider error status=502");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("private response body");
  });

  test("bounds generic tool errors", () => {
    const error = sanitizeToolResultError({
      toolCallId: "tool-call-1",
      toolName: "web-search",
      success: false,
      data: undefined,
      error: "x".repeat(1_000),
    });

    expect(error?.length).toBe(303);
    expect(error).toEndWith("...");
  });
});
