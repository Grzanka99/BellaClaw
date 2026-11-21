package one.scary.bellaclaw.model

/** A reasoning effort; the server names each in lower case. */
enum class Effort {
    OFF,
    MINIMAL,
    LOW,
    MEDIUM,
    HIGH,
    XHIGH,
    MAX,
}

/** A service tier; the server names each in lower case. [DEFAULT] is no tier. */
enum class ServiceTier {
    DEFAULT,
    FLEX,
    PRIORITY,
}

/** A provider a plain chat may use, with its [models]; a send can use it now only when it [isUsable]. */
data class ChatProvider(
    val id: String,
    val isUsable: Boolean,
    val models: List<AiModel>,
)

/** Provider, model and effort picked for one plain chat. */
data class ModelChoice(
    val providerId: String,
    val model: String,
    val effort: Effort,
)

enum class ModelRole {
    UTILITY,
    MAIN,
    SPECIALIST,
    SPECIALIST_ACCURATE,
    SCHEDULED_TASK,
}

/** One model of a provider, with the efforts it supports and whether it takes a service tier (a plain chat's list does not say). */
data class AiModel(
    val id: String,
    val name: String,
    val efforts: List<Effort>,
    val supportsServiceTier: Boolean = false,
)

/** A role's model id, its effort (null: the model's own default) and its service tier. */
data class RoleModel(
    val model: String,
    val effort: Effort?,
    val serviceTier: ServiceTier,
)

/**
 * BellaClaw's models as the server has them: the provider [providerId], one of [providers], a model
 * per role, and that provider's [models].
 */
data class ModelSettings(
    val providerId: String,
    val providers: List<String>,
    val roles: Map<ModelRole, RoleModel>,
    val models: List<AiModel>,
) {
    /** The model's name, or its id when the provider no longer lists it. */
    fun modelName(id: String): String = models.firstOrNull { it.id == id }?.name ?: id
}
