import type { TOption } from "@bellaclaw/shared";
import {
  type Api,
  isModelType,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider as bundledOpencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { z } from "zod";

const BASE_URL = "https://opencode.ai/zen/go";
const CATALOG_TTL = 60 * 60 * 1000;
const RETRY_COOLDOWN = 5 * 60 * 1000;
const SModelList = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });
const SMetadata = z.object({
  "opencode-go": z.object({ models: z.record(z.string(), z.unknown()) }),
});
const SCost = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
});
const SModelMetadata = z.object({
  name: z.string().min(1),
  tool_call: z.literal(true),
  status: z.string().optional(),
  reasoning: z.boolean().optional(),
  temperature: z.boolean().optional(),
  reasoning_options: z
    .array(z.object({ type: z.string(), values: z.array(z.string().nullable()).optional() }))
    .optional(),
  interleaved: z.union([z.boolean(), z.object({ field: z.string() })]).optional(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
  limit: z.object({ context: z.number().positive(), output: z.number().positive() }),
  provider: z.object({ npm: z.string().optional() }).optional(),
  cost: SCost.extend({
    tiers: z
      .array(
        SCost.extend({
          tier: z.object({ type: z.literal("context"), size: z.number().nonnegative() }),
        }),
      )
      .optional(),
  }),
});

function modelFromMetadata(id: string, metadata: unknown): TOption<Model<Api>> {
  const parsed = SModelMetadata.safeParse(metadata);
  if (
    !parsed.success ||
    parsed.data.status === "deprecated" ||
    !parsed.data.modalities.output.includes("text")
  ) {
    return undefined;
  }
  const source = parsed.data;
  const input: Model<Api>["input"] = ["text"];
  if (source.modalities.input.includes("image")) {
    input.push("image");
  }
  let thinkingLevelMap: TOption<ThinkingLevelMap>;
  const effort = source.reasoning_options?.find((option) => option.type === "effort");
  if (
    effort?.values?.some((value) =>
      ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value ?? ""),
    )
  ) {
    thinkingLevelMap = {};
    const levels: ModelThinkingLevel[] = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    for (const level of levels) {
      let value: string = level;
      if (level === "off") {
        value = "none";
      }
      if (effort.values.includes(value)) {
        thinkingLevelMap[level] = value;
      } else {
        thinkingLevelMap[level] = null;
      }
    }
  }
  const common = {
    id,
    name: source.name,
    provider: "opencode-go",
    reasoning: source.reasoning === true,
    thinkingLevelMap,
    input,
    contextWindow: source.limit.context,
    maxTokens: source.limit.output,
    cost: {
      input: source.cost.input,
      output: source.cost.output,
      cacheRead: source.cost.cache_read ?? 0,
      cacheWrite: source.cost.cache_write ?? 0,
      tiers: source.cost.tiers?.map((tier) => ({
        inputTokensAbove: tier.tier.size,
        input: tier.input,
        output: tier.output,
        cacheRead: tier.cache_read ?? 0,
        cacheWrite: tier.cache_write ?? 0,
      })),
    },
  };
  switch (source.provider?.npm) {
    case "@ai-sdk/anthropic":
      return {
        ...common,
        api: "anthropic-messages",
        baseUrl: BASE_URL,
        compat: {
          supportsTemperature: source.temperature,
          forceAdaptiveThinking: thinkingLevelMap !== undefined,
        },
      };
    case "@ai-sdk/openai":
      return {
        ...common,
        api: "openai-responses",
        baseUrl: `${BASE_URL}/v1`,
        compat: { sessionAffinityFormat: "openai-nosession" },
      };
    case undefined:
    case "@ai-sdk/openai-compatible": {
      const model: Model<"openai-completions"> = {
        ...common,
        api: "openai-completions",
        baseUrl: `${BASE_URL}/v1`,
        compat: { maxTokensField: "max_tokens" },
      };
      if (
        typeof source.interleaved === "object" &&
        source.interleaved.field === "reasoning_content"
      ) {
        model.compat = { ...model.compat, requiresReasoningContentOnAssistantMessages: true };
      }
      return model;
    }
    default:
      return undefined;
  }
}

export function opencodeGoProvider(requiredModelIds: readonly string[]): Provider {
  const bundled = bundledOpencodeGoProvider();
  const baseline = new Map(bundled.getModels().map((model) => [model.id, model]));
  let catalog: readonly Model<Api>[] = bundled.getModels();
  let checkedAt = 0;
  let attemptedAt = 0;
  // Required models must stay resolvable even when a catalog omits them.
  const addRequiredModels = (models: Model<Api>[]) => {
    for (const id of requiredModelIds) {
      const model = baseline.get(id);
      if (model !== undefined && !models.some((entry) => entry.id === id)) {
        models.push(model);
      }
    }
  };
  return {
    ...bundled,
    getModels: () => catalog,
    getAllModels: () => catalog,
    refreshModels: async (context) => {
      if (!context.allowNetwork) {
        if (context.stored !== undefined) {
          const stored = context.stored;
          const models = stored.models.filter((model) => isModelType(model, "chat"));
          addRequiredModels(models);
          await context.publish({
            update: () => {
              catalog = models;
              checkedAt = stored.checkedAt ?? 0;
            },
          });
        }
        return;
      }
      if (
        !context.force &&
        (Date.now() - checkedAt < CATALOG_TTL || Date.now() - attemptedAt < RETRY_COOLDOWN)
      ) {
        return;
      }
      attemptedAt = Date.now();
      const responses = await Promise.all([
        fetch(`${BASE_URL}/v1/models`, { signal: context.signal }),
        fetch("https://models.dev/api.json", { signal: context.signal }),
      ]);
      for (const response of responses) {
        if (!response.ok) {
          throw new Error(`OpenCode Go catalog request failed: HTTP ${response.status}`);
        }
      }
      const [list, metadata] = await Promise.all(responses.map((response) => response.json()));
      const parsedList = SModelList.safeParse(list);
      const parsedMetadata = SMetadata.safeParse(metadata);
      if (!parsedList.success || !parsedMetadata.success) {
        throw new Error("Invalid OpenCode Go catalog response");
      }
      const models: Model<Api>[] = [];
      for (const { id } of parsedList.data.data) {
        // Preserve Pi's verified protocol overrides for bundled models.
        const model =
          baseline.get(id) ?? modelFromMetadata(id, parsedMetadata.data["opencode-go"].models[id]);
        if (model !== undefined) {
          models.push(model);
        }
      }
      if (models.length === 0) {
        throw new Error("OpenCode Go catalog has no supported chat models");
      }
      addRequiredModels(models);
      const fetchedAt = Date.now();
      await context.publish({
        persist: { models, checkedAt: fetchedAt },
        update: () => {
          catalog = models;
          checkedAt = fetchedAt;
        },
      });
    },
  };
}
