import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { z } from "zod";
import { AgentHarness } from "../ai/agent-harness";
import { EModelPurpose, ERole } from "../ai/types";
import { EmbeddingClient } from "../embedding";
import type { TConfigRecord } from "../settings/schema";
import { Memory } from ".";
import type { TFactSearchResult, TLiveFactWindow, TMemory, TPreparedFact } from "./types";

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

// NOTE: retryable separates a transient model outage, which must not advance the checkpoint, from
// output this window will always produce, which would otherwise block the drain loop forever
export type TDistillationResult =
  | {
      success: true;
      facts: TDistilledFact[];
    }
  | {
      success: false;
      retryable: boolean;
    };

export type TProcessFactWindowArgs = {
  window: TLiveFactWindow;
  settings: TConfigRecord;
  trace: TOption<TBehaviorTraceContext>;
};

export type TFactWindowProcessResult =
  | {
      success: true;
    }
  | {
      success: false;
      reason: "distillation" | "embedding" | "candidate-search" | "supersession" | "commit";
    };

type TSupersessionSelection =
  | {
      success: true;
      factIds: number[];
    }
  | {
      success: false;
    };

type TFactPreparationResult =
  | {
      success: true;
      facts: TPreparedFact[];
    }
  | {
      success: false;
      reason: "embedding" | "candidate-search" | "supersession";
    };

export class FactDistiller {
  private static _instance: TOption<FactDistiller>;
  private logger = createLogger("FACT_DISTILLER");
  private ai = AgentHarness.instance;
  private embedding = EmbeddingClient.instance;
  private memory = Memory.instance;

  private constructor() {}

  public static get instance() {
    if (FactDistiller._instance === undefined) {
      FactDistiller._instance = new FactDistiller();
    }

    return FactDistiller._instance;
  }

  public async distill(
    window: TLiveFactWindow,
    settings: TConfigRecord,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<TDistillationResult> {
    const response = await this.ai.completeText({
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

    if (response === undefined) {
      this.logger.error("distill: utility model returned no response");
      return { success: false, retryable: true };
    }

    let responseJson: unknown;
    try {
      responseJson = JSON.parse(response);
    } catch (error) {
      this.logger.error(`distill: response was not valid JSON: ${String(error)}`);
      return { success: false, retryable: false };
    }

    const parsed = SDistillationResponse.safeParse(responseJson);
    if (!parsed.success) {
      this.logger.error("distill: response did not match expected shape");
      return { success: false, retryable: false };
    }

    const eligibleSourceIds = new Set<number>();
    for (const message of window.messages) {
      if (isEligibleFactSource(message, window.state.chatId)) {
        eligibleSourceIds.add(message.id);
      }
    }

    const eligibleFacts: TDistilledFact[] = [];
    for (const fact of parsed.data.facts) {
      if (!eligibleSourceIds.has(fact.sourceMessageId)) {
        this.logger.error(
          `distill: response cited ineligible source ${fact.sourceMessageId}, eligible were [${[...eligibleSourceIds].join(",")}]`,
        );
        continue;
      }

      eligibleFacts.push(fact);
    }

    return { success: true, facts: eligibleFacts };
  }

  public async processWindow(args: TProcessFactWindowArgs): Promise<TFactWindowProcessResult> {
    const finalMessage = args.window.messages.at(-1);
    if (finalMessage === undefined) {
      return { success: true };
    }

    let distillation: TDistillationResult = { success: false, retryable: false };
    for (let attempt = 1; attempt <= DISTILLATION_ATTEMPTS; attempt += 1) {
      try {
        distillation = await this.distill(args.window, args.settings, args.trace);
      } catch (error) {
        this.logger.error(`processWindow: distillation failed: ${String(error)}`);
        return {
          success: false,
          reason: "distillation",
        };
      }

      if (distillation.success || distillation.retryable) {
        break;
      }

      if (attempt < DISTILLATION_ATTEMPTS) {
        this.logger.warning(
          `processWindow: retrying window through ${finalMessage.id} after unusable distillation output`,
        );
      }
    }

    let distilledFacts: TDistilledFact[] = [];
    if (distillation.success) {
      distilledFacts = distillation.facts;
    } else if (distillation.retryable) {
      return {
        success: false,
        reason: "distillation",
      };
    } else {
      this.logger.warning(
        `processWindow: skipping window through ${finalMessage.id} after ${DISTILLATION_ATTEMPTS} unusable distillation responses`,
      );
    }

    const prepared = await this.prepareFacts(distilledFacts, args);
    if (!prepared.success) {
      return prepared;
    }

    try {
      const result = await this.memory.commitLiveFactWindow({
        chatId: args.window.state.chatId,
        expectedLastProcessedMessageId: args.window.state.lastProcessedMessageId,
        lastProcessedMessageId: finalMessage.id,
        facts: prepared.facts,
      });

      if (!result.committed) {
        this.logger.error("processWindow: fact window checkpoint was stale");
        return {
          success: false,
          reason: "commit",
        };
      }
    } catch (error) {
      this.logger.error(`processWindow: fact window commit failed: ${String(error)}`);
      return {
        success: false,
        reason: "commit",
      };
    }

    return { success: true };
  }

  private async prepareFacts(
    distilledFacts: TDistilledFact[],
    args: TProcessFactWindowArgs,
  ): Promise<TFactPreparationResult> {
    let embeddings: number[][] = [];
    if (distilledFacts.length > 0) {
      let embeddingResult: TOption<number[][]>;
      try {
        embeddingResult = await this.embedding.embedMany(distilledFacts.map((fact) => fact.text));
      } catch (error) {
        this.logger.error(`prepareFacts: embedding failed: ${String(error)}`);
        return {
          success: false,
          reason: "embedding",
        };
      }

      if (embeddingResult === undefined || embeddingResult.length !== distilledFacts.length) {
        this.logger.error("prepareFacts: embedding failed");
        return {
          success: false,
          reason: "embedding",
        };
      }

      embeddings = embeddingResult;
    }

    const facts: TPreparedFact[] = [];
    const selectedSupersededFactIds = new Set<number>();
    for (let index = 0; index < distilledFacts.length; index += 1) {
      const fact = distilledFacts[index];
      const embedding = embeddings[index];
      if (fact === undefined || embedding === undefined) {
        this.logger.error("prepareFacts: embedding result did not match distilled facts");
        return {
          success: false,
          reason: "embedding",
        };
      }

      let searchResults: TFactSearchResult[];
      try {
        searchResults = await this.memory.findLiveFactCandidates(
          args.window.state.chatId,
          embedding,
        );
      } catch (error) {
        this.logger.error(`prepareFacts: candidate search failed: ${String(error)}`);
        return {
          success: false,
          reason: "candidate-search",
        };
      }

      const candidates = searchResults.filter(
        (candidate) => !selectedSupersededFactIds.has(candidate.id),
      );
      let supersedesFactIds: number[] = [];
      if (candidates.length > 0) {
        let selection: TSupersessionSelection;
        try {
          selection = await this.selectSupersededFactIds(
            fact,
            candidates,
            args.settings,
            args.trace,
          );
        } catch (error) {
          this.logger.error(`prepareFacts: supersession selection failed: ${String(error)}`);
          return {
            success: false,
            reason: "supersession",
          };
        }

        if (!selection.success) {
          return {
            success: false,
            reason: "supersession",
          };
        }

        for (const factId of selection.factIds) {
          selectedSupersededFactIds.add(factId);
        }

        supersedesFactIds = selection.factIds;
      }

      facts.push({
        text: fact.text,
        sourceMessageId: fact.sourceMessageId,
        embedding,
        supersedesFactIds,
      });
    }

    return {
      success: true,
      facts,
    };
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

  private async selectSupersededFactIds(
    fact: TDistilledFact,
    candidates: TFactSearchResult[],
    settings: TConfigRecord,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<TSupersessionSelection> {
    const offeredIds = new Set(candidates.map((candidate) => candidate.id));
    const candidateLines = candidates.map((candidate) => `[id=${candidate.id}] ${candidate.text}`);
    const response = await this.ai.completeText({
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

    if (response === undefined) {
      this.logger.error("selectSupersededFactIds: utility model returned no response");
      return { success: false };
    }

    let responseJson: unknown;
    try {
      responseJson = JSON.parse(response);
    } catch (error) {
      this.logger.error(`selectSupersededFactIds: response was not valid JSON: ${String(error)}`);
      return { success: false };
    }

    const parsed = SSupersessionResponse.safeParse(responseJson);
    if (!parsed.success) {
      this.logger.error("selectSupersededFactIds: response did not match expected shape");
      return { success: false };
    }

    for (const factId of parsed.data.factIds) {
      if (!offeredIds.has(factId)) {
        this.logger.error("selectSupersededFactIds: response selected an unoffered fact ID");
        return { success: false };
      }
    }

    return {
      success: true,
      factIds: [...new Set(parsed.data.factIds)],
    };
  }
}

function isEligibleFactSource(message: TMemory, chatId: string): boolean {
  if (message.chatId !== chatId || message.author !== ERole.User) {
    return false;
  }

  // NOTE: a message that is only a question carries no durable claim, but one that states something
  // before asking still does. Judging the whole row by its final punctuation drops the claim, and
  // the checkpoint then advances past it for good.
  const clauses = message.message
    .split(/(?<=[.!?？;])\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

  return clauses.some((clause) => !clause.endsWith("?") && !clause.endsWith("？"));
}
