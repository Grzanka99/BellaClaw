package one.scary.bellaclaw.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.ui.appContainer

class SettingsViewModel(
    settingsRepository: SettingsRepository,
    private val accountRepository: AccountRepository,
) : ViewModel() {
    private val signOut = MutableStateFlow(SignOut())

    val uiState: StateFlow<SettingsUiState> = combine(
        settingsRepository.settings,
        accountRepository.session,
        signOut,
    ) { settings, session, signOut ->
        SettingsUiState(
            providerName = settings.provider.name,
            mainModel = settings.models.roles.getValue(ModelRole.MAIN).model,
            personalityInChats = settings.personality.useInChats,
            themeMode = settings.theme.mode,
            dynamicColor = settings.theme.dynamicColor,
            username = session?.username.orEmpty(),
            serverUrl = session?.serverUrl.orEmpty(),
            isSigningOut = signOut.isRunning,
            signOutError = signOut.error,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SettingsUiState())

    /** A success or a `401` ends the session, which returns the app to sign-in; another failure keeps it and shows why. */
    fun signOut() {
        if (signOut.value.isRunning) {
            return
        }
        signOut.value = SignOut(isRunning = true)
        viewModelScope.launch {
            signOut.value = SignOut(error = accountRepository.signOut())
        }
    }

    private data class SignOut(val isRunning: Boolean = false, val error: AccountError? = null)

    companion object {
        val Factory = viewModelFactory {
            initializer {
                val container = appContainer()
                SettingsViewModel(container.settingsRepository, container.accountRepository)
            }
        }
    }
}
