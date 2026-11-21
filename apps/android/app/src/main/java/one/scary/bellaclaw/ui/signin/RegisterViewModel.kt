package one.scary.bellaclaw.ui.signin

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.toRoute
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.ui.appContainer
import one.scary.bellaclaw.ui.navigation.RegisterDestination

/**
 * Creates an account with the server's activation code. The server and the username survive process
 * death in [savedStateHandle]; the password and the activation code never go there.
 */
class RegisterViewModel(
    private val accountRepository: AccountRepository,
    initialServerUrl: String,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val serverUrl = savedStateHandle.getMutableStateFlow(SERVER_KEY, initialServerUrl)
    private val username = savedStateHandle.getMutableStateFlow(USERNAME_KEY, "")
    private val password = MutableStateFlow("")
    private val activationCode = MutableStateFlow("")
    private val request = MutableStateFlow(Request())

    val uiState: StateFlow<RegisterUiState> = combine(serverUrl, username, password, activationCode, request) { serverUrl, username, password, code, request ->
        RegisterUiState(serverUrl, username, password, code, request.isLoading, request.error)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), RegisterUiState())

    fun onServerUrlChange(text: String) {
        serverUrl.value = text
        request.value = Request()
    }

    fun onUsernameChange(text: String) {
        username.value = text
        request.value = Request()
    }

    fun onPasswordChange(text: String) {
        password.value = text
        request.value = Request()
    }

    fun onActivationCodeChange(text: String) {
        activationCode.value = text
        request.value = Request()
    }

    /** A success starts the session, which replaces the sign-in screens. */
    fun register() {
        if (!uiState.value.canRegister) {
            return
        }
        request.value = Request(isLoading = true)
        viewModelScope.launch {
            val error = accountRepository.register(
                serverUrl.value,
                username.value.trim(),
                password.value,
                activationCode.value.trim(),
            )
            request.value = Request(error = error)
        }
    }

    private data class Request(val isLoading: Boolean = false, val error: AccountError? = null)

    companion object {
        private const val SERVER_KEY = "serverUrl"
        private const val USERNAME_KEY = "username"

        val Factory = viewModelFactory {
            initializer {
                val savedStateHandle = createSavedStateHandle()
                RegisterViewModel(
                    appContainer().accountRepository,
                    savedStateHandle.toRoute<RegisterDestination>().serverUrl,
                    savedStateHandle,
                )
            }
        }
    }
}
