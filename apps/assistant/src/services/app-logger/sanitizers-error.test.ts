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

  const cronPolicy = { logSafe: [], privateErrors: true };

  test("logs the ToolError code instead of the cron error message", () => {
    const error = sanitizeToolResultError(
      {
        toolCallId: "tool-call-1",
        toolName: "update-cron-job",
        success: false,
        data: { errorCode: "job-not-found" },
        error: "No job found with name: private-health-reminder",
      },
      cronPolicy,
    );

    expect(error).toBe("update-cron-job failed: job-not-found");
  });

  test("drops cron errors that carry no code", () => {
    const error = sanitizeToolResultError(
      {
        toolCallId: "tool-call-1",
        toolName: "schedule-once",
        success: false,
        data: {},
        error:
          'Validation failed for tool "schedule-once":\n\nReceived arguments:\n{"reminderText":"private note"}',
      },
      cronPolicy,
    );

    expect(error).toBe("schedule-once failed");
  });

  test("ignores error codes from tools without a log policy", () => {
    const error = sanitizeToolResultError(
      {
        toolCallId: "tool-call-1",
        toolName: "mcp-tool",
        success: false,
        data: { errorCode: "server-chosen" },
        error: "MCP tool failed",
      },
      undefined,
    );

    expect(error).toBe("MCP tool failed");
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
    const error = sanitizeToolResultError(
      {
        toolCallId: "tool-call-1",
        toolName: "web-search",
        success: false,
        data: {},
        error: "x".repeat(1_000),
      },
      { logSafe: [], privateErrors: false },
    );

    expect(error?.length).toBe(303);
    expect(error).toEndWith("...");
  });
});
