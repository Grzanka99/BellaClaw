package one.scary.bellaclaw.data.remote

import kotlinx.serialization.Serializable

// Request and answer bodies of the account's settings: /api/model, /api/models and /api/personality. Efforts
// and purposes stay the server's strings here; SettingsRepository maps them.

/** The answer of GET and PUT /api/model: [availableModels] are the models of the active [provider]. */
@Serializable
data class ModelStateBody(
    val provider: String,
    val providers: List<String>,
    val purposes: List<PurposeBody>,
    val availableModels: List<AvailableModelBody>,
)

/** [effort] is `default` for the model's own default; [serviceTier] is `default` for no tier. */
@Serializable
data class PurposeBody(val purpose: String, val model: String, val effort: String, val serviceTier: String)

/** The model list of GET /api/models has no [supportsServiceTier]. */
@Serializable
data class AvailableModelBody(
    val id: String,
    val name: String,
    val supportedEfforts: List<String>,
    val supportsServiceTier: Boolean = false,
)

/** The answer of GET /api/models: every provider a plain chat may use. */
@Serializable
data class ModelCatalogBody(val providers: List<CatalogProviderBody>)

@Serializable
data class CatalogProviderBody(
    val id: String,
    val usable: Boolean,
    val models: List<AvailableModelBody>,
)

/** PUT /api/model; a null field is left out. */
@Serializable
data class ModelUpdateBody(
    val aiProvider: String? = null,
    val aiModelPurpose: String? = null,
    val aiModel: String? = null,
    val aiReasoningEffort: String? = null,
    val aiServiceTier: String? = null,
    val resetAiModel: Boolean? = null,
    val resetAiReasoningEffort: Boolean? = null,
)

/** GET and PUT /api/personality, both ways. */
@Serializable
data class PersonalityBody(
    val bellaPersona: String,
    val plainChatsUseBellaPersona: Boolean,
    val plainChatsPersona: String,
)
