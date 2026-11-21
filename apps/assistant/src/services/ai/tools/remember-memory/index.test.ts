import { describe, expect, mock, test } from "bun:test";
import { EEventType } from "@bellaclaw/database";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { CommandRejectedError, type TEventRequester } from "../../../events";
import { ERejectionCode } from "../../../events/catalog";
import { testEventRequester } from "../../../events/test-utils";
import { EMBEDDING_UNAVAILABLE, MEMORY_REQUEST_TIMEOUT_MS } from "../../../memory";
import { DefaultConfigRecord } from "../../../settings/schema";
import { rememberMemory, SRememberMemoryArgs } from ".";

const args = { fact: " The user likes tea. ", sourceMessage: "I like tea.", supersedesFactIds: [] };

function execute(request: ReturnType<typeof mock>) {
  return rememberMemory
    .createAgentTool({
      conversationKey: "discord:1",
      ownerKey: "discord:2",
      settings: DefaultConfigRecord,
      trace: { turnId: "test", chatId: undefined, platform: undefined },
      events: { ...testEventRequester, request: request as unknown as TEventRequester["request"] },
      verifySettings: mock(async () => undefined),
      runScheduledTask: mock(async () => {
        throw new Error("not used");
      }),
    })
    .execute("call", args);
}

describe("SRememberMemoryArgs", () => {
  test("accepts a fact with its source message", () => {
    expect(
      compile(SRememberMemoryArgs, { formats }).check({
        fact: "The user likes tea.",
        sourceMessage: "I like tea.",
        supersedesFactIds: [],
      }),
    ).toBe(true);
  });
});

describe("remember-memory", () => {
  test("requests the trimmed fact for the owner on the conversation's memory lane", async () => {
    const request = mock(async () => ({ payload: { chatId: "discord:2", factId: 7 } }));

    const result = await execute(request);

    expect(request).toHaveBeenCalledWith(
      EEventType.MemoryFactRememberRequested,
      {
        chatId: "discord:2",
        conversationKey: "discord:1",
        text: "The user likes tea.",
        sourceMessage: "I like tea.",
        supersedesFactIds: [],
      },
      expect.objectContaining({
        outcome: EEventType.MemoryFactRemembered,
        key: "discord:1",
        timeoutMs: MEMORY_REQUEST_TIMEOUT_MS,
      }),
    );
    expect(result.details).toEqual({ rememberedFactId: 7 });
  });

  test("keeps the embedding error unprefixed and prefixes other rejections", async () => {
    await expect(
      execute(
        mock(async () => {
          throw new CommandRejectedError(
            ERejectionCode.Failed,
            "Embedding service unavailable",
            EMBEDDING_UNAVAILABLE,
          );
        }),
      ),
    ).rejects.toThrow(/^Embedding service unavailable$/);
    await expect(
      execute(
        mock(async () => {
          throw new CommandRejectedError(ERejectionCode.Failed, "no source", undefined);
        }),
      ),
    ).rejects.toThrow("Memory remember failed: Error: no source");
  });
});
