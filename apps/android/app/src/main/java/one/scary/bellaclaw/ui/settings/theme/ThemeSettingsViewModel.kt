package one.scary.bellaclaw.ui.settings.theme

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.appContainer

/** Theme changes apply at once; there is no Save. */
class ThemeSettingsViewModel(private val settingsRepository: SettingsRepository) : ViewModel() {
    val uiState: StateFlow<ThemeSettingsUiState> = settingsRepository.settings
        .map { ThemeSettingsUiState(it.theme.mode, it.theme.dynamicColor) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ThemeSettingsUiState())

    fun selectMode(mode: ThemeMode) {
        viewModelScope.launch {
            settingsRepository.setThemeMode(mode)
        }
    }

    fun setDynamicColor(enabled: Boolean) {
        viewModelScope.launch {
            settingsRepository.setDynamicColor(enabled)
        }
    }

    companion object {
        val Factory = viewModelFactory {
            initializer { ThemeSettingsViewModel(appContainer().settingsRepository) }
        }
    }
}
