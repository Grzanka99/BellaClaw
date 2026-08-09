import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { z } from "zod";
import { AgentHarness } from "../ai/agent-harness";
import { EModelPurpose, ERole } from "../ai/types";
import { EmbeddingClient } from "../embedding";
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
    factId: z.number().int().positive().nullable(),
  })
  .strict();
const MODEL_REQUEST_TIMEOUT_MS = 60_000;

export type TDistilledFact = z.infer<typeof SDistilledFact>;

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
      factId: TOption<number>;
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
  ): Promise<TOption<TDistilledFact[]>> {
    const response = await this.ai.completeText({
      prompt: this.createDistillationPrompt(window),
      instructions: [
        "Extract durable facts explicitly stated by the user.",
        "Prior context and assistant messages are context only and must never be cited.",
        "Every fact must cite one eligible current-window user message ID.",
        'Reply with only JSON in this exact shape: {"facts":[{"text":"...","sourceMessageId":123}]}.',
        'If there are no durable user facts, reply with {"facts":[]}.',
      ].join(" "),
      purpose: EModelPurpose.Utility,
      settings,
      trace,
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    });

    if (response === undefined) {
      this.logger.error("distill: utility model returned no response");
      return undefined;
    }

    let responseJson: unknown;
    try {
      responseJson = JSON.parse(response);
    } catch (error) {
      this.logger.error(`distill: response was not valid JSON: ${String(error)}`);
      return undefined;
    }

    const parsed = SDistillationResponse.safeParse(responseJson);
    if (!parsed.success) {
      this.logger.error("distill: response did not match expected shape");
      return undefined;
    }

    const eligibleSourceIds = new Set<number>();
    for (const message of window.messages) {
      if (message.chatId === window.state.chatId && message.author === ERole.User) {
        eligibleSourceIds.add(message.id);
      }
    }

    for (const fact of parsed.data.facts) {
      if (!eligibleSourceIds.has(fact.sourceMessageId)) {
        this.logger.error("distill: response cited an ineligible source message");
        return undefined;
      }
    }

    return parsed.data.facts;
  }

  public async processWindow(args: TProcessFactWindowArgs): Promise<TFactWindowProcessResult> {
    const finalMessage = args.window.messages.at(-1);
    if (finalMessage === undefined) {
      return { success: true };
    }

    let distilledFacts: TOption<TDistilledFact[]>;
    try {
      distilledFacts = await this.distill(args.window, args.settings, args.trace);
    } catch (error) {
      this.logger.error(`processWindow: distillation failed: ${String(error)}`);
      return {
        success: false,
        reason: "distillation",
      };
    }

    if (distilledFacts === undefined) {
      return {
        success: false,
        reason: "distillation",
      };
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
      let supersedesFactId: TOption<number>;
      if (candidates.length > 0) {
        let selection: TSupersessionSelection;
        try {
          selection = await this.selectSupersededFactId(
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

        if (selection.factId !== undefined) {
          selectedSupersededFactIds.add(selection.factId);
          supersedesFactId = selection.factId;
        }
      }

      facts.push({
        text: fact.text,
        sourceMessageId: fact.sourceMessageId,
        embedding,
        supersedesFactId,
      });
    }

    return {
      success: true,
      facts,
    };
  }

  private createDistillationPrompt(window: TLiveFactWindow): string {
    const lines = ["PROCESSED CONTEXT — DO NOT CITE:"];

    if (window.context.length === 0) {
      lines.push("(none)");
    } else {
      for (const message of window.context) {
        lines.push(`[id=${message.id}][${message.author}][CONTEXT ONLY] ${message.message}`);
      }
    }

    lines.push("", "CURRENT WINDOW:");
    for (const message of window.messages) {
      let sourceLabel = "CONTEXT ONLY";
      if (message.chatId === window.state.chatId && message.author === ERole.User) {
        sourceLabel = "ELIGIBLE SOURCE";
      }

      lines.push(`[id=${message.id}][${message.author}][${sourceLabel}] ${message.message}`);
    }

    return lines.join("\n");
  }

  private async selectSupersededFactId(
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
        "Decide whether the new fact replaces exactly one offered live fact.",
        "Use null when it adds information, is compatible, or no offered fact is directly replaced.",
        'Reply with only JSON in this exact shape: {"factId":123} or {"factId":null}.',
      ].join(" "),
      purpose: EModelPurpose.Utility,
      settings,
      trace,
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    });

    if (response === undefined) {
      this.logger.error("selectSupersededFactId: utility model returned no response");
      return { success: false };
    }

    let responseJson: unknown;
    try {
      responseJson = JSON.parse(response);
    } catch (error) {
      this.logger.error(`selectSupersededFactId: response was not valid JSON: ${String(error)}`);
      return { success: false };
    }

    const parsed = SSupersessionResponse.safeParse(responseJson);
    if (!parsed.success) {
      this.logger.error("selectSupersededFactId: response did not match expected shape");
      return { success: false };
    }

    if (parsed.data.factId === null) {
      return {
        success: true,
        factId: undefined,
      };
    }

    if (!offeredIds.has(parsed.data.factId)) {
      this.logger.error("selectSupersededFactId: response selected an unoffered fact ID");
      return { success: false };
    }

    return {
      success: true,
      factId: parsed.data.factId,
    };
  }
}
