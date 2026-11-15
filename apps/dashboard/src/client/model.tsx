/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import { useEffect, useState } from "hono/jsx/dom";
import type {
  TDashboardModelState,
  TDashboardModelUpdate,
  TDashboardServiceTier,
} from "../api-types";
import { api, chatPath } from "./api";
import { Select } from "./select";

type TSelection = TDashboardModelState["purposes"][number];

const SERVICE_TIERS: TDashboardServiceTier[] = ["default", "flex", "priority"];

type TPurposeCardProps = {
  // what the assistant uses now
  selection: TSelection;
  // what the controls show
  draft: TSelection;
  models: TDashboardModelState["availableModels"];
  disabled: boolean;
  verifying: boolean;
  error: TOption<string>;
  onDraft: (draft: TSelection) => void;
  onUpdate: (update: TDashboardModelUpdate) => void;
};

function PurposeCard({
  selection,
  draft,
  models,
  disabled,
  verifying,
  error,
  onDraft,
  onUpdate,
}: TPurposeCardProps) {
  const model = models.find((candidate) => candidate.id === draft.model);
  const efforts: TSelection["effort"][] = ["default", ...(model?.supportedEfforts ?? [])];
  // only what differs from the selection, so an untouched control changes nothing
  const update: TDashboardModelUpdate = { aiModelPurpose: selection.purpose };

  if (draft.model !== selection.model) {
    update.aiModel = draft.model;
  }

  if (draft.effort !== selection.effort) {
    if (draft.effort === "default") {
      update.resetAiReasoningEffort = true;
    } else {
      update.aiReasoningEffort = draft.effort;
    }
  }

  if (model?.supportsServiceTier === true && draft.serviceTier !== selection.serviceTier) {
    update.aiServiceTier = draft.serviceTier;
  }

  return (
    <section class="card">
      <h2>{selection.purpose.replace(/([a-z])([A-Z])/g, "$1 $2")}</h2>
      <Select
        label="Model"
        value={draft.model}
        options={models.map(({ id, name }) => ({ value: id, label: name }))}
        disabled={disabled}
        onChange={(id) => {
          const next = models.find((candidate) => candidate.id === id);
          let effort = draft.effort;

          // an effort the new model lacks falls back to its default
          if (next?.supportedEfforts.some((supported) => supported === effort) !== true) {
            effort = "default";
          }

          onDraft({ ...draft, model: id, effort });
        }}
      />
      <Select
        label="Effort"
        value={draft.effort}
        options={efforts.map((effort) => ({ value: effort, label: effort }))}
        disabled={disabled}
        onChange={(effort) => onDraft({ ...draft, effort })}
      />
      {model?.supportsServiceTier === true && (
        <Select
          label="Service tier"
          value={draft.serviceTier}
          options={SERVICE_TIERS.map((tier) => ({ value: tier, label: tier }))}
          disabled={disabled}
          onChange={(serviceTier) => onDraft({ ...draft, serviceTier })}
        />
      )}
      {verifying && (
        <p class="muted">The assistant is verifying the model. This can take a few minutes…</p>
      )}
      {error !== undefined && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      <div class="row">
        <button
          class="button"
          type="button"
          disabled={disabled || Object.keys(update).length === 1}
          onClick={() => onUpdate(update)}
        >
          Save
        </button>
        <button
          class="button outline"
          type="button"
          disabled={disabled}
          onClick={() => onUpdate({ aiModelPurpose: selection.purpose, resetAiModel: true })}
        >
          Reset to default
        </button>
      </div>
    </section>
  );
}

export function ModelTab({ chatId }: { chatId: string }) {
  const [state, setState] = useState<TOption<TDashboardModelState>>(undefined);
  // unsaved choices by purpose
  const [drafts, setDrafts] = useState<Record<string, TSelection>>({});
  // the request in flight: "load", "provider" or a purpose
  const [busy, setBusy] = useState<TOption<string>>("load");
  // scope: the request that failed, named like `busy`
  const [failure, setFailure] = useState<TOption<{ scope: string; message: string }>>(undefined);

  async function request(scope: string, method: string, update: TOption<TDashboardModelUpdate>) {
    setBusy(scope);
    setFailure(undefined);
    const result = await api<TDashboardModelState>(method, chatPath(chatId, "model"), update);
    setBusy(undefined);

    if ("error" in result) {
      setFailure({ scope, message: result.error });
      return;
    }

    setState(result.data);

    if (scope === "provider") {
      // another provider has other models
      setDrafts({});
    } else {
      setDrafts(({ [scope]: _saved, ...others }) => others);
    }
  }

  useEffect(() => {
    void request("load", "GET", undefined);
  }, []);

  if (state === undefined) {
    if (failure !== undefined) {
      return (
        <p class="alert" role="alert">
          {failure.message}
        </p>
      );
    }

    return <p class="muted">Loading…</p>;
  }

  return (
    <>
      <section class="card">
        <Select
          label="Provider"
          value={state.provider}
          options={state.providers.map((provider) => ({ value: provider, label: provider }))}
          disabled={busy !== undefined}
          onChange={(aiProvider) => void request("provider", "PUT", { aiProvider })}
        />
        {busy === "provider" && (
          <p class="muted">
            The assistant is verifying the provider's models. This can take a few minutes…
          </p>
        )}
        {failure?.scope === "provider" && (
          <p class="alert" role="alert">
            {failure.message}
          </p>
        )}
      </section>
      <div class="purposes">
        {state.purposes.map((selection) => {
          let error: TOption<string>;

          if (failure?.scope === selection.purpose) {
            error = failure.message;
          }

          return (
            <PurposeCard
              key={selection.purpose}
              selection={selection}
              draft={drafts[selection.purpose] ?? selection}
              models={state.availableModels}
              disabled={busy !== undefined}
              verifying={busy === selection.purpose}
              error={error}
              onDraft={(draft) => setDrafts({ ...drafts, [selection.purpose]: draft })}
              onUpdate={(update) => void request(selection.purpose, "PUT", update)}
            />
          );
        })}
      </div>
    </>
  );
}
