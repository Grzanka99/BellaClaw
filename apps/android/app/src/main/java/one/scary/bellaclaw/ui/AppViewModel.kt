package one.scary.bellaclaw.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.model.ThemeSettings

/** What the whole app is drawn with: the theme, which navigation graph shows, and whether a login link waits. */
data class AppUiState(
    val theme: ThemeSettings = ThemeSettings(ThemeMode.SYSTEM, dynamicColor = false),
    val isSignedIn: Boolean = false,
    val hasPendingLink: Boolean = false,
)

/** App-wide UI state. */
class AppViewModel(
    settingsRepository: SettingsRepository,
    private val accountRepository: AccountRepository,
) : ViewModel() {
    val uiState: StateFlow<AppUiState> = combine(
        settingsRepository.settings,
        accountRepository.session,
        accountRepository.pendingLink,
    ) { settings, session, pendingLink ->
        AppUiState(settings.theme, isSignedIn = session != null, hasPendingLink = pendingLink != null)
    }.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        AppUiState(
            theme = settingsRepository.settings.value.theme,
            isSignedIn = accountRepository.session.value != null,
            hasPendingLink = accountRepository.pendingLink.value != null,
        ),
    )

    /** A `bellaclaw://login` deep link arrived; it waits for the user's confirmation. */
    fun onLoginLink(link: String) {
        accountRepository.openLink(link)
    }

    companion object {
        val Factory = viewModelFactory {
            initializer {
                val container = appContainer()
                AppViewModel(container.settingsRepository, container.accountRepository)
            }
        }
    }
}
