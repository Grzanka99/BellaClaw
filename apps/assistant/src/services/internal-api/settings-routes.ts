import { EEventType } from "@bellaclaw/database";
import {
  SGatewayModelUpdate,
  SGatewayPersonalityUpdate,
  type TGatewayModelCatalog,
  type TGatewayModelChoice,
  type TGatewayModelState,
  type TGatewayPersonality,
  type TOption,
} from "@bellaclaw/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";
import { findAiLoginProblem } from "../ai/auth";
import { LlmClient } from "../ai/llm";
import { decodeAiModelPreferences } from "../ai/model-preferences";
import {
  aiModels,
  checkAiModelChoice,
  EAiModelChoiceProblem,
  getAiApiKey,
  getAiModelConfigs,
  refreshAiModels,
  supportsAiServiceTier,
} from "../ai/providers/registry";
import { resolveAiProvider } from "../ai/tools/get-settings";
import {
  prepareAiSettingsUpdate,
  validateAiSettingsArgs,
} from "../ai/tools/update-settings/ai-settings";
import { EAiProvider, EModelPurpose, SAiProvider } from "../ai/types";
import type { TModelChoice } from "../events/catalog";
import type { TAccountKeys } from "../identity";
import { SettingsService, type TConfigUpdate } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";
import { COMMAND_TIMEOUT_MS, requestOutcome } from "./outcomes";
import { describeIssues, systemTrace } from "./shared";

// the shared body, with provider and purpose narrowed to the assistant's enums
const SModelUpdate = SGatewayModelUpdate.extend({
  aiProvider: SAiProvider.optional(),
  aiModelPurpose: z.enum(EModelPurpose).optional(),
});

function createModelState(settings: TConfigRecord): TGatewayModelState {
  const provider = resolveAiProvider(settings);
  const models = getAiModelConfigs(
    provider,
    decodeAiModelPreferences(settings[EConfigKey.AiModelPreferences]),
  );

  return {
    provider,
    providers: Object.values(EAiProvider),
    purposes: Object.values(EModelPurpose).map((purpose) => ({ purpose, ...models[purpose] })),
    availableModels: aiModels.getModels(provider).map((model) => ({
      id: model.id,
      name: model.name,
      supportedEfforts: getSupportedThinkingLevels(model),
      supportsServiceTier: supportsAiServiceTier(model),
    })),
  };
}

// every provider with its models, and why a send cannot use it now. A catalog that loads over the
// network is refreshed only for a provider that can be used
export async function createModelCatalog(): Promise<TGatewayModelCatalog> {
  const providers: TGatewayModelCatalog["providers"] = [];

  for (const provider of Object.values(EAiProvider)) {
    const reason = await findProviderProblem(provider);

    if (reason === undefined) {
      await refreshAiModels(provider);
    }

    providers.push({
      id: provider,
      usable: reason === undefined,
      reason,
      models: aiModels.getModels(provider).map((model) => ({
        id: model.id,
        name: model.name,
        supportedEfforts: getSupportedThinkingLevels(model),
      })),
    });
  }

  return { providers };
}

// the same checks, verification and settings.update.requested command as the update-settings tool.
// The trace names the account's Bella conversation.
async function updateModel(
  { ownerKey, conversationKey }: TAccountKeys,
  body: unknown,
): Promise<TConfigRecord> {
  const args = SModelUpdate.safeParse(body);

  if (!args.success) {
    throw new Error(describeIssues(args.error));
  }

  const trace = systemTrace(conversationKey);
  const updates: TConfigUpdate[] = [];
  const { settings } = await prepareAiSettingsUpdate(
    ownerKey,
    args.data,
    validateAiSettingsArgs(args.data),
    updates,
    (nextSettings, purposes) => LlmClient.instance.verifySettings(nextSettings, purposes, trace),
  );

  if (updates.length === 0) {
    return settings;
  }

  return requestOutcome(
    trace,
    ownerKey,
    EEventType.SettingsUpdateRequested,
    { ownerKey, updates },
    EEventType.SettingsChanged,
    (outcome) => outcome.record,
    COMMAND_TIMEOUT_MS,
    "Settings update timed out",
  );
}

function createPersonality(settings: TConfigRecord): TGatewayPersonality {
  return {
    bellaPersona: settings[EConfigKey.AiInstructionsPersona],
    plainChatsUseBellaPersona: settings[EConfigKey.AiPlainChatsUseBellaPersona] === "true",
    plainChatsPersona: settings[EConfigKey.AiPlainChatsPersona],
  };
}

// the settings.update.requested command a change in chat makes, so Settings validates the values
// the same way: a blank Bella persona or no field at all is refused. The trace names the account's
// Bella conversation
async function updatePersonality(
  { ownerKey, conversationKey }: TAccountKeys,
  body: unknown,
): Promise<TConfigRecord> {
  const update = SGatewayPersonalityUpdate.safeParse(body);

  if (!update.success) {
    throw new Error(describeIssues(update.error));
  }

  const updates: TConfigUpdate[] = [];

  if (update.data.bellaPersona !== undefined) {
    updates.push({ key: EConfigKey.AiInstructionsPersona, value: update.data.bellaPersona });
  }

  if (update.data.plainChatsUseBellaPersona !== undefined) {
    updates.push({
      key: EConfigKey.AiPlainChatsUseBellaPersona,
      value: String(update.data.plainChatsUseBellaPersona),
    });
  }

  if (update.data.plainChatsPersona !== undefined) {
    updates.push({ key: EConfigKey.AiPlainChatsPersona, value: update.data.plainChatsPersona });
  }

  return requestOutcome(
    systemTrace(conversationKey),
    ownerKey,
    EEventType.SettingsUpdateRequested,
    { ownerKey, updates },
    EEventType.SettingsChanged,
    (outcome) => outcome.record,
    COMMAND_TIMEOUT_MS,
    "Settings update timed out",
  );
}

// why the provider cannot be used now: its API key is missing, or its OAuth login is not connected
// or expired
async function findProviderProblem(provider: EAiProvider): Promise<TOption<string>> {
  try {
    getAiApiKey(provider);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  return findAiLoginProblem(provider);
}

// A plain chat's model as the app chose it, checked against what the server offers: a provider of
// its own that is usable now (its API key is set, its OAuth login is connected), a model that
// provider lists, an effort the model supports
export async function checkModelChoice(choice: TGatewayModelChoice): Promise<TModelChoice> {
  const provider = SAiProvider.safeParse(choice.provider);

  if (!provider.success) {
    throw new Error(`Unknown AI provider: ${choice.provider}`);
  }

  const providerProblem = await findProviderProblem(provider.data);

  if (providerProblem !== undefined) {
    throw new Error(providerProblem);
  }

  const problem = await checkAiModelChoice(provider.data, choice.model, choice.effort);

  if (problem === EAiModelChoiceProblem.ModelUnavailable) {
    throw new Error(`Model "${choice.model}" is not available from provider "${provider.data}"`);
  }

  if (problem === EAiModelChoiceProblem.EffortUnsupported) {
    throw new Error(`Effort ${choice.effort} is unsupported by ${choice.model}`);
  }

  return { provider: provider.data, model: choice.model, effort: choice.effort };
}

export async function handlePersonality(
  request: Request,
  account: TAccountKeys,
): Promise<Response> {
  let settings: TConfigRecord;

  if (request.method === "PUT") {
    settings = await updatePersonality(account, await request.json());
  } else {
    settings = await SettingsService.instance.getAll(account.ownerKey);
  }

  return Response.json(createPersonality(settings));
}

export async function handleModel(request: Request, account: TAccountKeys): Promise<Response> {
  if (request.method === "PUT") {
    return Response.json(createModelState(await updateModel(account, await request.json())));
  }

  const settings = await SettingsService.instance.getAll(account.ownerKey);
  await refreshAiModels(resolveAiProvider(settings), true);

  return Response.json(createModelState(settings));
}
