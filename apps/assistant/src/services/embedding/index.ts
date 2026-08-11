import { createLogger, type TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "../database/schema";

const DEFAULT_BASE_URL = "http://localhost:11434";
const EMBEDDING_MODEL = "paraphrase-multilingual";
const MAX_INPUT_LENGTH = 800;
const REQUEST_TIMEOUT_MS = 30_000;

const SEmbeddingResponse = z.object({
  embeddings: z.array(z.array(z.number())),
});

export class EmbeddingClient {
  private static _instance: TOption<EmbeddingClient>;
  private logger = createLogger("EMBEDDING");
  // NOTE: deliberately not OLLAMA_BASE_URL — that one points at the Ollama LLM provider, which
  // may be a different host that serves no embedding model
  private baseUrl = (Bun.env.BELLACLAW_EMBEDDING_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  private constructor() {}

  public static get instance() {
    if (!EmbeddingClient._instance) {
      EmbeddingClient._instance = new EmbeddingClient();
    }

    return EmbeddingClient._instance;
  }

  public async embed(input: string): Promise<TOption<number[]>> {
    const embeddings = await this.embedMany([input]);
    if (embeddings === undefined) {
      return undefined;
    }

    return embeddings[0];
  }

  public async embedMany(inputs: string[]): Promise<TOption<number[][]>> {
    try {
      const cappedInputs = inputs.map((input) => input.slice(0, MAX_INPUT_LENGTH));
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: cappedInputs,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error(`embedMany: /api/embed returned ${response.status}`);
        return undefined;
      }

      let responseJson: unknown;
      try {
        responseJson = await response.json();
      } catch (error) {
        this.logger.error(`embedMany: response was not valid JSON: ${String(error)}`);
        return undefined;
      }

      const parsed = SEmbeddingResponse.safeParse(responseJson);
      if (!parsed.success) {
        this.logger.error("embedMany: response did not match expected shape");
        return undefined;
      }

      if (parsed.data.embeddings.length !== cappedInputs.length) {
        this.logger.error("embedMany: response embedding count did not match input count");
        return undefined;
      }

      if (parsed.data.embeddings.some((embedding) => embedding.length !== EMBEDDING_DIMENSIONS)) {
        this.logger.error(
          `embedMany: response embedding was not ${EMBEDDING_DIMENSIONS} dimensions`,
        );
        return undefined;
      }

      return parsed.data.embeddings;
    } catch (error) {
      this.logger.error(`embedMany: request failed: ${String(error)}`);
      return undefined;
    }
  }
}
