package one.scary.bellaclaw.model

enum class Effort {
    LOW,
    MEDIUM,
    HIGH,
}

data class Provider(
    val id: String,
    val name: String,
    val models: List<String>,
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

data class RoleModel(
    val model: String,
    val effort: Effort,
)

/** BellaClaw's models: one provider, a model and effort per role, and that provider's defaults. */
data class ModelSettings(
    val providerId: String,
    val roles: Map<ModelRole, RoleModel>,
    val defaults: Map<ModelRole, RoleModel>,
) {
    fun isCustom(role: ModelRole): Boolean = roles[role] != defaults[role]
}
