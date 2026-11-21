package one.scary.bellaclaw.ui.signin

import one.scary.bellaclaw.model.AccountError

data class RegisterUiState(
    val serverUrl: String = "",
    val username: String = "",
    val password: String = "",
    val activationCode: String = "",
    val isLoading: Boolean = false,
    val error: AccountError? = null,
) {
    val canRegister: Boolean
        get() = !isLoading &&
            serverUrl.isNotBlank() &&
            username.isNotBlank() &&
            password.isNotEmpty() &&
            activationCode.isNotBlank()

    override fun toString() = "RegisterUiState(serverUrl=$serverUrl, username=$username, isLoading=$isLoading, error=$error)"
}
