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

/** One model of a provider, with the efforts it supports. */
data class AiModel(
    val id: String,
    val name: String,
    val efforts: List<Effort>,
)

/** A role's model id and its effort (null: the model's own default). */
data class RoleModel(
    val model: String,
    val effort: Effort?,
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
