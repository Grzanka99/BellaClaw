package one.scary.bellaclaw.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.ui.appContainer

class SettingsViewModel(settingsRepository: SettingsRepository) : ViewModel() {
    val uiState: StateFlow<SettingsUiState> = settingsRepository.settings.map { settings ->
        SettingsUiState(
            providerName = settings.provider.name,
            mainModel = settings.models.roles.getValue(ModelRole.MAIN).model,
            personalityInChats = settings.personality.useInChats,
            themeMode = settings.theme.mode,
            dynamicColor = settings.theme.dynamicColor,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SettingsUiState())

    companion object {
        val Factory = viewModelFactory {
            initializer { SettingsViewModel(appContainer().settingsRepository) }
        }
    }
}
