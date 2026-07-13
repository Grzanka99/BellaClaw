import { afterEach, describe, expect, test } from "bun:test";
import { sanitizeErrorMessage, sanitizeToolResultError } from "./sanitizers";

const originalOpenrouterApiKey = Bun.env.OPENROUTER_API_KEY;
const originalOpencodeApiKey = Bun.env.OPENCODE_API_KEY;

function restoreEnv(name: "OPENROUTER_API_KEY" | "OPENCODE_API_KEY", value: string | undefined) {
  if (value === undefined) {
    delete Bun.env[name];
    return;
  }

  Bun.env[name] = value;
}

describe("app logger sanitizer errors", () => {
  afterEach(() => {
    restoreEnv("OPENROUTER_API_KEY", originalOpenrouterApiKey);
    restoreEnv("OPENCODE_API_KEY", originalOpencodeApiKey);
  });

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

  test("redacts configured provider API keys from errors", () => {
    Bun.env.OPENROUTER_API_KEY = "openrouter-secret-key";
    Bun.env.OPENCODE_API_KEY = "opencode-secret-key";

    const error = sanitizeErrorMessage(
      "OpenRouter openrouter-secret-key failed; OpenCode opencode-secret-key failed",
    );

    expect(error).toBe("OpenRouter [REDACTED] failed; OpenCode [REDACTED] failed");
    expect(error).not.toContain("openrouter-secret-key");
    expect(error).not.toContain("opencode-secret-key");
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
});
