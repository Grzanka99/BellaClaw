package one.scary.bellaclaw.ui.signin

import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LoginLinkProblem

data class SignInUiState(
    val serverUrl: String = "",
    val username: String = "",
    val password: String = "",
    val code: String = "",
    val isLoading: Boolean = false,
    val error: AccountError? = null,
    val codeProblem: LoginLinkProblem? = null,
) {
    val canSignIn: Boolean
        get() = !isLoading && serverUrl.isNotBlank() && username.isNotBlank() && password.isNotEmpty()

    val canUseCode: Boolean
        get() = !isLoading && code.isNotBlank()

    override fun toString() = "SignInUiState(serverUrl=$serverUrl, username=$username, isLoading=$isLoading, error=$error)"
}
