package one.scary.bellaclaw.data

import one.scary.bellaclaw.data.remote.AvailableModelBody
import one.scary.bellaclaw.data.remote.ModelCatalogBody
import one.scary.bellaclaw.data.remote.ModelStateBody
import one.scary.bellaclaw.data.remote.PersonalityBody
import one.scary.bellaclaw.model.AiModel
import one.scary.bellaclaw.model.ChatProvider
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.ModelSettings
import one.scary.bellaclaw.model.Personality
import one.scary.bellaclaw.model.RoleModel

// The server's settings bodies to the app's types and back. The server names efforts in lower case
// and purposes in PascalCase.

internal fun ModelRole.purpose(): String = when (this) {
    ModelRole.UTILITY -> "Utility"
    ModelRole.MAIN -> "Main"
    ModelRole.SPECIALIST -> "Specialist"
    ModelRole.SPECIALIST_ACCURATE -> "SpecialistAccurate"
    ModelRole.SCHEDULED_TASK -> "ScheduledTask"
}

internal fun Effort.wireName(): String = name.lowercase()

/** `default` and anything unknown read as null: the model's own default. */
private fun effortOf(name: String): Effort? = Effort.entries.firstOrNull { it.wireName() == name }

internal fun ModelStateBody.toModelSettings() = ModelSettings(
    providerId = provider,
    providers = providers,
    roles = purposes.mapNotNull { purpose ->
        val role = ModelRole.entries.firstOrNull { it.purpose() == purpose.purpose } ?: return@mapNotNull null
        role to RoleModel(purpose.model, effortOf(purpose.effort))
    }.toMap(),
    models = availableModels.map { it.toAiModel() },
)

internal fun ModelCatalogBody.toChatProviders() = providers.map { provider ->
    ChatProvider(provider.id, provider.usable, provider.reason, provider.models.map { it.toAiModel() })
}

private fun AvailableModelBody.toAiModel() = AiModel(id, name, supportedEfforts.mapNotNull(::effortOf))

internal fun PersonalityBody.toPersonality() = Personality(bellaPersona, plainChatsUseBellaPersona, plainChatsPersona)
