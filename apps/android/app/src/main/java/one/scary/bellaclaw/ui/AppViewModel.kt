package one.scary.bellaclaw.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.model.ThemeSettings

/**
 * What the whole app is drawn with: the theme, which navigation graph shows, whether a login link waits,
 * and the chat a tapped notification opens, until it is opened.
 */
data class AppUiState(
    val theme: ThemeSettings = ThemeSettings(ThemeMode.SYSTEM, dynamicColor = false),
    val isSignedIn: Boolean = false,
    val hasPendingLink: Boolean = false,
    val chatToOpen: String? = null,
)

/** App-wide UI state. */
class AppViewModel(
    settingsRepository: SettingsRepository,
    private val accountRepository: AccountRepository,
) : ViewModel() {
    private val chatToOpen = MutableStateFlow<String?>(null)

    val uiState: StateFlow<AppUiState> = combine(
        settingsRepository.settings,
        accountRepository.session,
        accountRepository.pendingLink,
        chatToOpen,
    ) { settings, session, pendingLink, chatId ->
        AppUiState(settings.theme, isSignedIn = session != null, hasPendingLink = pendingLink != null, chatToOpen = chatId)
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

    /** A notification of [chatId] was tapped; it opens while signed in. */
    fun onOpenChat(chatId: String) {
        if (accountRepository.session.value != null) {
            chatToOpen.value = chatId
        }
    }

    fun onChatOpened() {
        chatToOpen.value = null
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
