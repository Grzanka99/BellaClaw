import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import { resetMessageAuthorizationsTable } from "../database/test-utils";
import { AuthorizationService, EAuthorizationDecision } from ".";

type TAuthorizationServiceStatic = {
  _instance: TOption<AuthorizationService>;
};

const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;

function resetSingleton() {
  const service = AuthorizationService as unknown as TAuthorizationServiceStatic;
  service._instance = undefined;
}

async function expectAuthorization(
  chatId: string,
  content: string,
  decision: EAuthorizationDecision,
  failedAttempts: number,
) {
  expect(await AuthorizationService.instance.authorize(chatId, content)).toEqual({
    decision,
    failedAttempts,
  });
}

beforeEach(async () => {
  resetSingleton();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = "open-sesame";
  await resetMessageAuthorizationsTable();
});

afterEach(() => {
  resetSingleton();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = originalActivationToken;
});

describe("AuthorizationService", () => {
  test("allows every message when activation is disabled", async () => {
    Bun.env.BELLACLAW_ACTIVATION_TOKEN = "   ";

    await expectAuthorization("discord:user-1", "hello", EAuthorizationDecision.Allow, 0);
  });

  test("authorizes a sender and restores authorization from the database", async () => {
    await expectAuthorization(
      "discord:user-1",
      "  open-sesame\n",
      EAuthorizationDecision.Activated,
      0,
    );
    await expectAuthorization("discord:user-1", "normal message", EAuthorizationDecision.Allow, 0);
    await expectAuthorization(
      "discord:user-1",
      "open-sesame",
      EAuthorizationDecision.AlreadyActivated,
      0,
    );

    resetSingleton();

    await expectAuthorization(
      "discord:user-1",
      "normal after restart",
      EAuthorizationDecision.Allow,
      0,
    );
  });

  test("keeps a sender locked across restarts after three failed messages", async () => {
    await expectAuthorization("signal:+100", "first", EAuthorizationDecision.FailedAttempt, 1);
    await expectAuthorization("signal:+100", "second", EAuthorizationDecision.FailedAttempt, 2);
    await expectAuthorization("signal:+100", "third", EAuthorizationDecision.Locked, 3);
    await expectAuthorization("signal:+100", "open-sesame", EAuthorizationDecision.Locked, 3);

    resetSingleton();

    await expectAuthorization("signal:+100", "open-sesame", EAuthorizationDecision.Locked, 3);
  });

  test("tracks platform identities separately", async () => {
    await AuthorizationService.instance.authorize("discord:owner", "open-sesame");

    await expectAuthorization("discord:owner", "hello", EAuthorizationDecision.Allow, 0);
    await expectAuthorization("signal:owner", "hello", EAuthorizationDecision.FailedAttempt, 1);
  });

  test("serializes concurrent attempts at the hard limit", async () => {
    const results = await Promise.all([
      AuthorizationService.instance.authorize("discord:user-1", "one"),
      AuthorizationService.instance.authorize("discord:user-1", "two"),
      AuthorizationService.instance.authorize("discord:user-1", "three"),
      AuthorizationService.instance.authorize("discord:user-1", "open-sesame"),
    ]);

    expect(results).toEqual([
      { decision: EAuthorizationDecision.FailedAttempt, failedAttempts: 1 },
      { decision: EAuthorizationDecision.FailedAttempt, failedAttempts: 2 },
      { decision: EAuthorizationDecision.Locked, failedAttempts: 3 },
      { decision: EAuthorizationDecision.Locked, failedAttempts: 3 },
    ]);
  });
});
