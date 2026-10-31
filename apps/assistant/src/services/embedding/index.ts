import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "../database/schema";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "bellaclaw/embeddinggemma-2:270m-bf16-text";
// NOTE: text-only GGUF; Ollama's own BF16 tags need the MLX runtime, and pulling this repo
// through hf.co would also fetch the vision/audio projector
const DEFAULT_MODEL_URL =
  "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-BF16.gguf";
const MAX_INPUT_LENGTH = 800;
const REQUEST_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const DOWNLOAD_LOG_STEP_BYTES = 100_000_000;
// NOTE: EmbeddingGemma task prefixes; the search cutoffs in services/memory depend on them
const DOCUMENT_PREFIX = "title: none | text: ";
const QUERY_PREFIX = "task: search result | query: ";

const SEmbeddingResponse = z.object({
  embeddings: z.array(z.array(z.number())),
});

export class EmbeddingClient {
  private static _instance: TOption<EmbeddingClient>;
  private logger = createLogger("EMBEDDING");
  // NOTE: deliberately not OLLAMA_BASE_URL — that one points at the Ollama LLM provider, which
  // may be a different host that serves no embedding model
  private baseUrl = (Bun.env.BELLACLAW_EMBEDDING_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  public readonly model: string;
  public readonly modelUrl: TOption<string>;

  private constructor() {
    const model = Bun.env.BELLACLAW_EMBEDDING_MODEL?.trim();
    if (model) {
      this.model = model;
      this.modelUrl = Bun.env.BELLACLAW_EMBEDDING_MODEL_URL?.trim() || undefined;
    } else {
      this.model = DEFAULT_MODEL;
      this.modelUrl = DEFAULT_MODEL_URL;
    }
  }

  public static get instance() {
    if (!EmbeddingClient._instance) {
      EmbeddingClient._instance = new EmbeddingClient();
    }

    return EmbeddingClient._instance;
  }

  // NOTE: a missing model is imported from modelUrl when set, otherwise pulled from the Ollama
  // library
  public async ensureModel(): Promise<boolean> {
    try {
      const shown = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (shown.ok) {
        return true;
      }

      if (this.modelUrl !== undefined) {
        return await this.importModel(this.modelUrl);
      }

      this.logger.info(`ensureModel: ${this.model} not found locally, pulling`);
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
        }),
        signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error(
          `ensureModel: /api/pull returned ${response.status}: ${await response.text()}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(`ensureModel: request failed: ${String(error)}`);
      return false;
    }
  }

  private async importModel(url: string): Promise<boolean> {
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-embedding-"));
    const path = join(directory, "model.gguf");

    try {
      this.logger.info(`importModel: downloading ${url}`);
      const download = await fetch(url, { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
      if (!download.ok || download.body === null) {
        this.logger.error(`importModel: download returned ${download.status}`);
        return false;
      }

      const totalMb = Math.round(Number(download.headers.get("content-length")) / 1e6);
      const writer = Bun.file(path).writer();
      const hasher = new Bun.CryptoHasher("sha256");
      let bytes = 0;
      let nextLogAt = DOWNLOAD_LOG_STEP_BYTES;
      for await (const chunk of download.body) {
        writer.write(chunk);
        hasher.update(chunk);
        bytes += chunk.length;
        if (bytes >= nextLogAt) {
          this.logger.info(`importModel: downloaded ${Math.round(bytes / 1e6)}/${totalMb}MB`);
          nextLogAt += DOWNLOAD_LOG_STEP_BYTES;
        }
      }
      await writer.end();
      const digest = `sha256:${hasher.digest("hex")}`;

      this.logger.info(`importModel: uploading ${Math.round(bytes / 1e6)}MB to Ollama`);
      const upload = await fetch(`${this.baseUrl}/api/blobs/${digest}`, {
        method: "POST",
        body: Bun.file(path),
        signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
      });
      if (!upload.ok) {
        this.logger.error(`importModel: /api/blobs returned ${upload.status}`);
        return false;
      }

      const created = await fetch(`${this.baseUrl}/api/create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          files: { "model.gguf": digest },
          stream: false,
        }),
        signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
      });
      if (!created.ok) {
        this.logger.error(
          `importModel: /api/create returned ${created.status}: ${await created.text()}`,
        );
        return false;
      }

      this.logger.info(`importModel: created ${this.model}`);
      return true;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  public async embed(input: string): Promise<TOption<number[]>> {
    const embeddings = await this.embedMany([input]);
    if (embeddings === undefined) {
      return undefined;
    }

    return embeddings[0];
  }

  public async embedQuery(query: string): Promise<TOption<number[]>> {
    const embeddings = await this.embedWithPrefix(QUERY_PREFIX, [query]);
    if (embeddings === undefined) {
      return undefined;
    }

    return embeddings[0];
  }

  public async embedMany(inputs: string[]): Promise<TOption<number[][]>> {
    return this.embedWithPrefix(DOCUMENT_PREFIX, inputs);
  }

  private async embedWithPrefix(prefix: string, inputs: string[]): Promise<TOption<number[][]>> {
    try {
      const cappedInputs = inputs.map((input) => `${prefix}${input.slice(0, MAX_INPUT_LENGTH)}`);
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
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
