import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EModelPurpose, ERole } from "../ai/types";
import { DefaultConfigRecord } from "../settings/schema";
import { FactDistiller } from "./distill";
import type { TFactSearchResult, TLiveFactWindow, TMemory } from "./types";
import { EMemoryImportance } from "./types";

type TDistillerInternals = {
  ai: {
    completeText: ReturnType<typeof mock>;
  };
  embedding: {
    embedMany: ReturnType<typeof mock>;
  };
  memory: {
    findLiveFactCandidates: ReturnType<typeof mock>;
    commitLiveFactWindow: ReturnType<typeof mock>;
  };
};

function makeMemory(id: number, author: ERole, message: string, chatId = "chat-comet"): TMemory {
  return {
    id,
    chatId,
    author,
    importance: EMemoryImportance.Medium,
    message,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReadAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeWindow(): TLiveFactWindow {
  return {
    state: {
      chatId: "chat-comet",
      lastProcessedMessageId: 10,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    context: [makeMemory(9, ERole.User, "The ceramics club hosts workshops.")],
    messages: [
      makeMemory(11, ERole.User, "I attend on Tuesdays."),
      makeMemory(12, ERole.Assistant, "I will remember that."),
    ],
  };
}

function makeEmbedding(value: number): number[] {
  return Array.from({ length: 768 }, () => value);
}

function makeCandidate(id: number): TFactSearchResult {
  return {
    id,
    text: "The bicycle used to be named Spark.",
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
    sourceMessageId: 4,
    distance: 0.1,
  };
}

function resetDistiller() {
  const DistillerWithInternals = FactDistiller as unknown as {
    _instance: unknown;
  };
  DistillerWithInternals._instance = undefined;
}

function setupDistiller() {
  const distiller = FactDistiller.instance;
  const internals = distiller as unknown as TDistillerInternals;
  internals.ai = {
    completeText: mock(async () => undefined),
  };
  internals.embedding = {
    embedMany: mock(async () => undefined),
  };
  internals.memory = {
    findLiveFactCandidates: mock(async () => []),
    commitLiveFactWindow: mock(async () => ({ committed: true, facts: [] })),
  };
  return { distiller, internals };
}

beforeEach(resetDistiller);
afterEach(resetDistiller);

describe("FactDistiller", () => {
  test("parses structured facts and marks only current user rows eligible", async () => {
    const { distiller, internals } = setupDistiller();
    const window = makeWindow();
    window.messages.push(makeMemory(13, ERole.User, "Where does the user live?"));
    window.messages.push(makeMemory(14, ERole.User, "ユーザーはどこに住んでいますか？"));
    internals.ai.completeText = mock(
      async () =>
        '{"facts":[{"text":"The user attends ceramics on Tuesdays.","sourceMessageId":11}]}',
    );

    const result = await distiller.distill(window, DefaultConfigRecord, undefined);

    expect(result).toEqual({
      success: true,
      facts: [
        {
          text: "The user attends ceramics on Tuesdays.",
          sourceMessageId: 11,
        },
      ],
    });
    expect(internals.ai.completeText).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: EModelPurpose.Utility,
        settings: DefaultConfigRecord,
        trace: undefined,
      }),
    );
    const prompt = internals.ai.completeText.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("[id=9][user][CONTEXT ONLY] The ceramics club hosts workshops.");
    expect(prompt).toContain("[id=11][user][ELIGIBLE SOURCE] I attend on Tuesdays.");
    expect(prompt).toContain("[id=12][assistant][CONTEXT ONLY] I will remember that.");
    expect(prompt).toContain("[id=13][user][CONTEXT ONLY] Where does the user live?");
    expect(prompt).toContain("[id=14][user][CONTEXT ONLY] ユーザーはどこに住んでいますか？");
  });

  test("rejects invalid JSON", async () => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(async () => "not-json");

    await expect(distiller.distill(makeWindow(), DefaultConfigRecord, undefined)).resolves.toEqual({
      success: false,
      retryable: false,
    });
  });

  test("rejects an invalid structured response", async () => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(async () => '{"facts":[{"text":"Missing provenance"}]}');

    await expect(distiller.distill(makeWindow(), DefaultConfigRecord, undefined)).resolves.toEqual({
      success: false,
      retryable: false,
    });
  });

  test.each([
    ["assistant", 12],
    ["prior context", 9],
    ["unknown", 999],
  ])("drops a %s source ID", async (_label, sourceMessageId) => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(async () =>
      JSON.stringify({
        facts: [{ text: "An ineligible claim.", sourceMessageId }],
      }),
    );

    await expect(distiller.distill(makeWindow(), DefaultConfigRecord, undefined)).resolves.toEqual({
      success: true,
      facts: [],
    });
  });

  test("keeps a user row eligible when a claim precedes a question", async () => {
    const { distiller, internals } = setupDistiller();
    const window = makeWindow();
    window.messages = [makeMemory(11, ERole.User, "Mam rower o imieniu Kometa; co o nim myslisz?")];
    internals.ai.completeText = mock(
      async () =>
        '{"facts":[{"text":"The user has a bicycle named Kometa.","sourceMessageId":11}]}',
    );

    const result = await distiller.distill(window, DefaultConfigRecord, undefined);

    expect(result).toEqual({
      success: true,
      facts: [{ text: "The user has a bicycle named Kometa.", sourceMessageId: 11 }],
    });
  });

  test("treats a question-only user row as an ineligible source", async () => {
    const { distiller, internals } = setupDistiller();
    const window = makeWindow();
    window.messages = [makeMemory(11, ERole.User, "Czy jestem w zwiazku?")];
    internals.ai.completeText = mock(
      async () =>
        '{"facts":[{"text":"The user asked about a relationship.","sourceMessageId":11}]}',
    );

    const result = await distiller.distill(window, DefaultConfigRecord, undefined);

    expect(result).toEqual({ success: true, facts: [] });
  });

  test("drops a current user row from another chat as a source", async () => {
    const { distiller, internals } = setupDistiller();
    const window = makeWindow();
    window.messages.push(makeMemory(13, ERole.User, "Other chat fact.", "chat-other"));
    internals.ai.completeText = mock(
      async () => '{"facts":[{"text":"Other chat fact.","sourceMessageId":13}]}',
    );

    await expect(distiller.distill(window, DefaultConfigRecord, undefined)).resolves.toEqual({
      success: true,
      facts: [],
    });
  });

  test("commits a zero-fact window and advances through the final assistant row", async () => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(async () => '{"facts":[]}');
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: true });
    expect(internals.embedding.embedMany).not.toHaveBeenCalled();
    expect(internals.memory.findLiveFactCandidates).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith({
      chatId: "chat-comet",
      expectedLastProcessedMessageId: 10,
      lastProcessedMessageId: 12,
      facts: [],
    });
  });

  test("retries once before skipping a window with unusable distillation output", async () => {
    const { distiller, internals } = setupDistiller();
    let calls = 0;
    internals.ai.completeText = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return "not-json";
      }

      return '{"facts":[{"text":"The user attends ceramics on Tuesdays.","sourceMessageId":11}]}';
    });
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;
    internals.embedding.embedMany = mock(async () => [makeEmbedding(0.25)]);

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: true });
    expect(calls).toBe(2);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: [expect.objectContaining({ text: "The user attends ceramics on Tuesdays." })],
      }),
    );
  });

  test("advances past a window whose distillation output is unusable on every attempt", async () => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(async () => "not-json");
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: true });
    expect(commit).toHaveBeenCalledWith({
      chatId: "chat-comet",
      expectedLastProcessedMessageId: 10,
      lastProcessedMessageId: 12,
      facts: [],
    });
  });

  test("does not advance when the utility model is unavailable", async () => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(async () => undefined);
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: false, reason: "distillation" });
    expect(commit).not.toHaveBeenCalled();
  });

  test("returns failure without candidate search or commit when embedding fails", async () => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(
      async () => '{"facts":[{"text":"The bicycle is named Comet.","sourceMessageId":11}]}',
    );
    internals.embedding.embedMany = mock(async () => undefined);
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: false, reason: "embedding" });
    expect(internals.memory.findLiveFactCandidates).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test("prepares a fact without supersession when there are no nearby candidates", async () => {
    const { distiller, internals } = setupDistiller();
    const vector = makeEmbedding(0.25);
    internals.ai.completeText = mock(
      async () => '{"facts":[{"text":"The bicycle is named Comet.","sourceMessageId":11}]}',
    );
    internals.embedding.embedMany = mock(async () => [vector]);
    internals.memory.findLiveFactCandidates = mock(async () => []);
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: true });
    expect(internals.embedding.embedMany).toHaveBeenCalledWith(["The bicycle is named Comet."]);
    expect(internals.memory.findLiveFactCandidates).toHaveBeenCalledWith("chat-comet", vector);
    expect(commit).toHaveBeenCalledWith({
      chatId: "chat-comet",
      expectedLastProcessedMessageId: 10,
      lastProcessedMessageId: 12,
      facts: [
        {
          text: "The bicycle is named Comet.",
          sourceMessageId: 11,
          embedding: vector,
          supersedesFactIds: [],
        },
      ],
    });
  });

  test("validates and commits an offered supersession candidate", async () => {
    const { distiller, internals } = setupDistiller();
    const vector = makeEmbedding(0.5);
    let completion = 0;
    internals.ai.completeText = mock(async () => {
      completion += 1;
      if (completion === 1) {
        return '{"facts":[{"text":"The bicycle is now named Comet.","sourceMessageId":11}]}';
      }

      return '{"factIds":[44]}';
    });
    internals.embedding.embedMany = mock(async () => [vector]);
    internals.memory.findLiveFactCandidates = mock(async () => [makeCandidate(44)]);
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: true });
    expect(internals.ai.completeText).toHaveBeenCalledTimes(2);
    expect(internals.ai.completeText.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        purpose: EModelPurpose.Utility,
        prompt: expect.stringContaining("[id=44] The bicycle used to be named Spark."),
      }),
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: [expect.objectContaining({ supersedesFactIds: [44] })],
      }),
    );
  });

  test("retires every contradicted candidate, not just the closest one", async () => {
    const { distiller, internals } = setupDistiller();
    const vector = makeEmbedding(0.5);
    let completion = 0;
    internals.ai.completeText = mock(async () => {
      completion += 1;
      if (completion === 1) {
        return '{"facts":[{"text":"The user timezone is Europe/Warsaw.","sourceMessageId":11}]}';
      }

      return '{"factIds":[44,45,44]}';
    });
    internals.embedding.embedMany = mock(async () => [vector]);
    internals.memory.findLiveFactCandidates = mock(async () => [
      makeCandidate(44),
      makeCandidate(45),
    ]);
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: true });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: [expect.objectContaining({ supersedesFactIds: [44, 45] })],
      }),
    );
  });

  test("rejects a supersession ID that was not offered and does not commit", async () => {
    const { distiller, internals } = setupDistiller();
    const vector = makeEmbedding(0.75);
    let completion = 0;
    internals.ai.completeText = mock(async () => {
      completion += 1;
      if (completion === 1) {
        return '{"facts":[{"text":"The bicycle is now named Comet.","sourceMessageId":11}]}';
      }

      return '{"factIds":[99]}';
    });
    internals.embedding.embedMany = mock(async () => [vector]);
    internals.memory.findLiveFactCandidates = mock(async () => [makeCandidate(44)]);
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: false, reason: "supersession" });
    expect(commit).not.toHaveBeenCalled();
  });

  test("does not select the same supersession candidate twice in one window", async () => {
    const { distiller, internals } = setupDistiller();
    let completion = 0;
    internals.ai.completeText = mock(async () => {
      completion += 1;
      if (completion === 1) {
        return JSON.stringify({
          facts: [
            { text: "The bicycle is named Comet.", sourceMessageId: 11 },
            { text: "The bicycle is blue.", sourceMessageId: 11 },
          ],
        });
      }

      if (completion === 2) {
        return '{"factIds":[44]}';
      }

      throw new Error("Candidate 44 must not be offered twice");
    });
    internals.embedding.embedMany = mock(async () => [makeEmbedding(0.5), makeEmbedding(0.75)]);
    internals.memory.findLiveFactCandidates = mock(async () => [makeCandidate(44)]);
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: true });
    expect(internals.ai.completeText).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: [
          expect.objectContaining({ supersedesFactIds: [44] }),
          expect.objectContaining({ supersedesFactIds: [] }),
        ],
      }),
    );
  });

  test("returns candidate-search failure without committing", async () => {
    const { distiller, internals } = setupDistiller();
    internals.ai.completeText = mock(
      async () => '{"facts":[{"text":"The bicycle is named Comet.","sourceMessageId":11}]}',
    );
    internals.embedding.embedMany = mock(async () => [makeEmbedding(1)]);
    internals.memory.findLiveFactCandidates = mock(async () => {
      throw new Error("candidate database unavailable");
    });
    const commit = mock(async () => ({ committed: true as const, facts: [] }));
    internals.memory.commitLiveFactWindow = commit;

    const result = await distiller.processWindow({
      window: makeWindow(),
      settings: DefaultConfigRecord,
      trace: undefined,
    });

    expect(result).toEqual({ success: false, reason: "candidate-search" });
    expect(commit).not.toHaveBeenCalled();
  });
});
