package one.scary.bellaclaw.ui.signin

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.ui.appContainer

/**
 * Signs in with a password, or hands a pasted login code to the link confirmation. The server and the
 * username survive process death in [savedStateHandle]; the password and the code never go there.
 */
class SignInViewModel(
    private val accountRepository: AccountRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val serverUrl = savedStateHandle.getMutableStateFlow(SERVER_KEY, accountRepository.lastServerUrl.orEmpty())
    private val username = savedStateHandle.getMutableStateFlow(USERNAME_KEY, "")
    private val password = MutableStateFlow("")
    private val code = MutableStateFlow("")
    private val request = MutableStateFlow(Request())

    val uiState: StateFlow<SignInUiState> = combine(serverUrl, username, password, code, request) { serverUrl, username, password, code, request ->
        SignInUiState(serverUrl, username, password, code, request.isLoading, request.error, request.codeProblem)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SignInUiState())

    fun onServerUrlChange(text: String) {
        serverUrl.value = text
        request.update { it.copy(error = null) }
    }

    fun onUsernameChange(text: String) {
        username.value = text
        request.update { it.copy(error = null) }
    }

    fun onPasswordChange(text: String) {
        password.value = text
        request.update { it.copy(error = null) }
    }

    fun onCodeChange(text: String) {
        code.value = text
        request.update { it.copy(codeProblem = null) }
    }

    /** A success starts the session, which replaces the sign-in screens. */
    fun signIn() {
        if (!uiState.value.canSignIn) {
            return
        }
        request.value = Request(isLoading = true)
        viewModelScope.launch {
            val error = accountRepository.signIn(serverUrl.value, username.value.trim(), password.value)
            request.value = Request(error = error)
        }
    }

    /** Holds a valid code for the link confirmation, which opens on its own; nothing is sent here. */
    fun useCode() {
        if (!uiState.value.canUseCode) {
            return
        }
        val problem = accountRepository.openCode(code.value)
        if (problem == null) {
            code.value = ""
        }
        request.update { it.copy(codeProblem = problem) }
    }

    private data class Request(
        val isLoading: Boolean = false,
        val error: AccountError? = null,
        val codeProblem: LoginLinkProblem? = null,
    )

    companion object {
        private const val SERVER_KEY = "serverUrl"
        private const val USERNAME_KEY = "username"

        val Factory = viewModelFactory {
            initializer { SignInViewModel(appContainer().accountRepository, createSavedStateHandle()) }
        }
    }
}
