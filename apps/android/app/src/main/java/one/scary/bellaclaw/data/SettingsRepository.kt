package one.scary.bellaclaw.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import one.scary.bellaclaw.data.sample.SampleSettings
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.ModelSettings
import one.scary.bellaclaw.model.Personality
import one.scary.bellaclaw.model.RoleModel
import one.scary.bellaclaw.model.SettingsSnapshot
import one.scary.bellaclaw.model.ThemeMode

/**
 * Single source of truth for settings: providers and their models, BellaClaw's models, personality
 * and the app theme, held in memory from [SampleSettings] as one [SettingsSnapshot].
 */
class SettingsRepository {
    private val state = MutableStateFlow(SampleSettings.settings)

    /** Every change replaces the whole snapshot, so readers never see a provider list and selection that disagree. */
    val settings: StateFlow<SettingsSnapshot> = state

    /** Switches BellaClaw to another provider; every role takes that provider's default. The current provider changes nothing. */
    suspend fun setProvider(providerId: String) {
        state.update { current ->
            if (current.models.providerId == providerId) {
                current
            } else {
                val defaults = SampleSettings.roleDefaults.getValue(providerId)
                current.copy(models = ModelSettings(providerId, defaults, defaults))
            }
        }
    }

    suspend fun setRoleModel(role: ModelRole, model: RoleModel) {
        state.update { it.copy(models = it.models.copy(roles = it.models.roles + (role to model))) }
    }

    suspend fun resetRole(role: ModelRole) {
        state.update { current ->
            val models = current.models
            current.copy(models = models.copy(roles = models.roles + (role to models.defaults.getValue(role))))
        }
    }

    suspend fun savePersonality(personality: Personality) {
        state.update { it.copy(personality = personality) }
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        state.update { it.copy(theme = it.theme.copy(mode = mode)) }
    }

    suspend fun setDynamicColor(enabled: Boolean) {
        state.update { it.copy(theme = it.theme.copy(dynamicColor = enabled)) }
    }
}
