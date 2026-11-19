package one.scary.bellaclaw.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.model.ThemeSettings

/** App-wide UI state: the theme every screen is drawn with. */
class AppViewModel(settingsRepository: SettingsRepository) : ViewModel() {
    val theme: StateFlow<ThemeSettings> = settingsRepository.settings
        .map { it.theme }
        .stateIn(viewModelScope, SharingStarted.Eagerly, ThemeSettings(ThemeMode.SYSTEM, dynamicColor = false))

    companion object {
        val Factory = viewModelFactory {
            initializer { AppViewModel(appContainer().settingsRepository) }
        }
    }
}
