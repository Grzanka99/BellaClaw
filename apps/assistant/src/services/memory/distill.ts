import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { z } from "zod";
import { LlmClient, LlmResponseError } from "../ai/llm";
import { EModelPurpose, ERole } from "../ai/types";
import { ConversationStore } from "../conversation";
import type { TSelectMemory } from "../database/schema";
import { EmbeddingClient } from "../embedding";
import { commandFailed, ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventType } from "../events/catalog";
import { SettingsService } from "../settings";
import type { TConfigRecord } from "../settings/schema";
import { Memory } from ".";
import type { TFactSearchResult, TLiveFactWindow, TPreparedFact } from "./types";

const SDistilledFact = z
  .object({
    text: z.string().trim().min(1),
    sourceMessageId: z.number().int().positive(),
  })
  .strict();
const SDistillationResponse = z.object({ facts: z.array(SDistilledFact) }).strict();
const SSupersessionResponse = z
  .object({
    factIds: z.array(z.number().int().positive()),
  })
  .strict();
const MODEL_REQUEST_TIMEOUT_MS = 60_000;
// NOTE: model formatting is nondeterministic, so a malformed reply often parses on a second try.
// Only skip the window once retries are exhausted, otherwise its facts are discarded for good.
const DISTILLATION_ATTEMPTS = 2;

export type TDistilledFact = z.infer<typeof SDistilledFact>;

export type TProcessFactWindowArgs = {
  window: TLiveFactWindow;
  settings: TConfigRecord;
  trace: TBehaviorTraceContext;
};

export class FactDistiller {
  private static _instance: TOption<FactDistiller>;
  private logger = createLogger("FACT_DISTILLER");
  private ai = LlmClient.instance;
  private embedding = EmbeddingClient.instance;
  private memory = Memory.instance;
  private conversations = ConversationStore.instance;

  private constructor() {}

  public static get instance() {
    if (FactDistiller._instance === undefined) {
      FactDistiller._instance = new FactDistiller();
    }

    return FactDistiller._instance;
  }

  // NOTE: post-turn drains and refreshes share the memory consumer's chat lane, so the drains of
  // one chat never overlap
  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "memory",
      type: EEventType.TurnCompleted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event) => {
        const chatId = event.payload.chatId;
        const settings = await SettingsService.instance.getAll(chatId);

        // NOTE: acked anyway: the checkpoint in fact_distillation_state makes the next drain
        // cover this window
        if (!(await this.drainLiveFactWindows(chatId, settings, event.trace))) {
          this.logger.error("turn.completed: fact drain failed");
        }
      },
    });
    bus.subscribe({
      consumer: "memory",
      type: EEventType.MemoryFactsRefreshRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const chatId = event.key;

        try {
          const settings = await SettingsService.instance.getAll(chatId);

          if (!(await this.drainLiveFactWindows(chatId, settings, event.trace))) {
            throw new Error("Pending fact distillation failed");
          }
        } catch (error) {
          await ctx.complete(async (_tx, emit) => {
            emit(
              EEventType.CommandRejected,
              commandFailed(event.type, error),
              undefined,
              undefined,
            );
          });
          return;
        }

        await ctx.complete(async (_tx, emit) => {
          emit(EEventType.MemoryFactsRefreshed, {}, undefined, undefined);
        });
      },
    });
    bus.subscribe({
      consumer: "memory",
      type: EEventType.AppStarted,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: (_event, ctx) => this.scheduleFactDrainForAllChats(ctx),
    });
  }

  // NOTE: without this, facts stay empty until the first inbound message of the process, so the
  // very first recall after a deploy answers from an unpopulated store. Catching up is best-effort
  // and must never fail boot — messaging works fine against a partially distilled store.
  // NOTE: one refresh command per chat puts each catch-up drain on that chat's memory lane; no one
  // waits for their outcome
  public async scheduleFactDrainForAllChats(ctx: TEventContext): Promise<void> {
    try {
      const chatIds = await this.conversations.findChatIds();

      await ctx.transact(async (_tx, emit) => {
        for (const chatId of chatIds) {
          emit(EEventType.MemoryFactsRefreshRequested, {}, chatId, chatId);
        }
      });
    } catch (error) {
      this.logger.error(`scheduleFactDrainForAllChats: boot fact drain failed: ${String(error)}`);
    }
  }

  public async distill(
    window: TLiveFactWindow,
    settings: TConfigRecord,
    trace: TBehaviorTraceContext,
  ): Promise<TDistilledFact[]> {
    const response = await this.ai.completeJson(SDistillationResponse, {
      prompt: this.createDistillationPrompt(window),
      instructions: [
        "Extract durable facts explicitly stated by the user.",
        "A durable fact is a stable attribute of the user or their world: identity, relationships,",
        "possessions, preferences, habits, health, work, or long-lived plans.",
        "Record only what stays true after this conversation ends.",
        "Each fact must carry exactly one claim. Split anything joined by 'and' into separate facts:",
        "a combined fact is retrieved and superseded far less reliably than its parts.",
        "Write every fact as one complete sentence that names its subject explicitly, normally",
        "starting with 'The user'. Never write a bare fragment such as 'Has a girlfriend named X':",
        "retrieval compares whole sentences, and fragments are matched far less reliably.",
        "Never record a request, instruction, or command the user gave the assistant.",
        "Never extract a restated fact when that same message asks the assistant to forget it.",
        "Reminders, alarms, schedules, cron jobs, settings changes, and provider or model choices",
        "are owned by other systems and must never become facts, even when the user states them.",
        "Never record that the user asked a question, and never record the assistant's own actions",
        "or state.",
        "Prefer the durable preference behind a request over the request itself: 'remind me to drink",
        "water' is not a fact, but 'the user wants to drink more water' is.",
        "Prior context and assistant messages are context only and must never be cited.",
        "Ground each complete fact claim in its cited eligible message.",
        "Use context only to resolve references or wording.",
        "Every fact must cite one eligible current-window user message ID.",
        'Reply with only JSON in this exact shape: {"facts":[{"text":"...","sourceMessageId":123}]}.',
        'Most windows contain no durable fact; when that is the case reply with {"facts":[]}.',
      ].join(" "),
      purpose: EModelPurpose.Utility,
      settings,
      trace,
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    });

    const eligibleSourceIds = new Set<number>();
    for (const message of window.messages) {
      if (isEligibleFactSource(message, window.state.chatId)) {
        eligibleSourceIds.add(message.id);
      }
    }

    const eligibleFacts = new Map<string, TDistilledFact>();
    for (const fact of response.facts) {
      if (!eligibleSourceIds.has(fact.sourceMessageId)) {
        this.logger.error(
          `distill: response cited ineligible source ${fact.sourceMessageId}, eligible were [${[...eligibleSourceIds].join(",")}]`,
        );
        continue;
      }

      const existing = eligibleFacts.get(fact.text);
      if (existing !== undefined && existing.sourceMessageId >= fact.sourceMessageId) {
        continue;
      }

      eligibleFacts.set(fact.text, fact);
    }

    return [...eligibleFacts.values()];
  }

  public async processWindow(args: TProcessFactWindowArgs): Promise<void> {
    const finalMessage = args.window.messages.at(-1);
    if (finalMessage === undefined) {
      return;
    }

    let distilledFacts: TDistilledFact[] = [];
    for (let attempt = 1; attempt <= DISTILLATION_ATTEMPTS; attempt += 1) {
      try {
        distilledFacts = await this.distill(args.window, args.settings, args.trace);
        break;
      } catch (error) {
        if (!(error instanceof LlmResponseError) || error.retryable) {
          throw error;
        }

        if (attempt < DISTILLATION_ATTEMPTS) {
          this.logger.warning(
            `processWindow: retrying window through ${finalMessage.id} after unusable distillation output: ${error.message}`,
          );
        } else {
          this.logger.warning(
            `processWindow: skipping window through ${finalMessage.id} after ${DISTILLATION_ATTEMPTS} unusable distillation responses: ${error.message}`,
          );
        }
      }
    }

    const facts = await this.prepareFacts(distilledFacts, args);

    const result = await this.memory.commitLiveFactWindow({
      chatId: args.window.state.chatId,
      expectedLastProcessedMessageId: args.window.state.lastProcessedMessageId,
      lastProcessedMessageId: finalMessage.id,
      facts,
    });

    if (!result.committed) {
      throw new Error("fact window checkpoint was stale");
    }
  }

  private async prepareFacts(
    distilledFacts: TDistilledFact[],
    args: TProcessFactWindowArgs,
  ): Promise<TPreparedFact[]> {
    let embeddings: number[][] = [];
    if (distilledFacts.length > 0) {
      const embeddingResult = await this.embedding.embedMany(
        distilledFacts.map((fact) => fact.text),
      );
      if (embeddingResult === undefined) {
        throw new Error("embedding failed");
      }

      embeddings = embeddingResult;
    }

    const facts: TPreparedFact[] = [];
    const selectedSupersededFactIds = new Set<number>();
    for (let index = 0; index < distilledFacts.length; index += 1) {
      const fact = distilledFacts[index];
      const embedding = embeddings[index];
      if (fact === undefined || embedding === undefined) {
        throw new Error("embedding result did not match distilled facts");
      }

      const searchResults = await this.memory.findLiveFactCandidates(
        args.window.state.chatId,
        embedding,
      );
      const candidates = searchResults.filter(
        (candidate) => !selectedSupersededFactIds.has(candidate.id),
      );
      let supersedesFactIds: number[] = [];
      if (candidates.length > 0) {
        supersedesFactIds = await this.selectSupersededFactIds(
          fact,
          candidates,
          args.settings,
          args.trace,
        );

        for (const factId of supersedesFactIds) {
          selectedSupersededFactIds.add(factId);
        }
      }

      facts.push({
        text: fact.text,
        sourceMessageId: fact.sourceMessageId,
        embedding,
        supersedesFactIds,
      });
    }

    return facts;
  }

  private createDistillationPrompt(window: TLiveFactWindow): string {
    const lines = ["ELIGIBLE CURRENT USER SOURCES — EXTRACT FACTS ONLY FROM THESE:"];

    const eligibleMessages = window.messages.filter((message) =>
      isEligibleFactSource(message, window.state.chatId),
    );
    if (eligibleMessages.length === 0) {
      lines.push("(none — return no facts)");
    } else {
      for (const message of eligibleMessages) {
        lines.push(`[id=${message.id}][${message.author}][ELIGIBLE SOURCE] ${message.message}`);
      }
    }

    lines.push("", "CONTEXT FOR WORDING — INELIGIBLE AS FACT SOURCES:");

    if (window.context.length === 0) {
      lines.push("(none)");
    } else {
      for (const message of window.context) {
        lines.push(`[id=${message.id}][${message.author}][CONTEXT ONLY] ${message.message}`);
      }
    }

    for (const message of window.messages) {
      if (isEligibleFactSource(message, window.state.chatId)) {
        continue;
      }

      lines.push(`[id=${message.id}][${message.author}][CONTEXT ONLY] ${message.message}`);
    }

    return lines.join("\n");
  }

  private async drainLiveFactWindows(
    chatId: string,
    settings: TConfigRecord,
    trace: TBehaviorTraceContext,
  ): Promise<boolean> {
    while (true) {
      const window = await this.memory.loadLiveFactWindow(chatId);
      if (window.messages.length === 0) {
        return true;
      }

      try {
        await this.processWindow({ window, settings, trace });
      } catch (error) {
        this.logger.error(`drainLiveFactWindows: stopped after failure: ${String(error)}`);
        return false;
      }
    }
  }

  private async selectSupersededFactIds(
    fact: TDistilledFact,
    candidates: TFactSearchResult[],
    settings: TConfigRecord,
    trace: TBehaviorTraceContext,
  ): Promise<number[]> {
    const offeredIds = new Set(candidates.map((candidate) => candidate.id));
    const candidateLines = candidates.map((candidate) => `[id=${candidate.id}] ${candidate.text}`);
    const response = await this.ai.completeJson(SSupersessionResponse, {
      prompt: [`NEW FACT: ${fact.text}`, "", "LIVE CANDIDATES:", ...candidateLines].join("\n"),
      instructions: [
        "Decide which of the offered live facts the new fact makes obsolete.",
        "Return every offered fact that the new fact restates or directly contradicts.",
        "Two facts contradict when they cannot both be true of the user at the same time, such as",
        "two different values for the same attribute; return all of them, not just the closest one.",
        "Return an empty list only when the new fact adds independent information that leaves every",
        "offered fact still true.",
        'Reply with only JSON in this exact shape: {"factIds":[123]} or {"factIds":[]}.',
      ].join(" "),
      purpose: EModelPurpose.Utility,
      settings,
      trace,
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    });

    for (const factId of response.factIds) {
      if (!offeredIds.has(factId)) {
        throw new Error("response selected an unoffered fact ID");
      }
    }

    return [...new Set(response.factIds)];
  }
}

function isEligibleFactSource(message: TSelectMemory, chatId: string): boolean {
  return message.chatId === chatId && message.author === ERole.User;
}
