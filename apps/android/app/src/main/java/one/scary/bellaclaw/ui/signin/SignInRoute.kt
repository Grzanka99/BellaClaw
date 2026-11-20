package one.scary.bellaclaw.ui.signin

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

@Composable
fun SignInRoute(
    onCreateAccount: (serverUrl: String) -> Unit,
    viewModel: SignInViewModel = viewModel(factory = SignInViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    SignInScreen(
        state = state,
        onServerUrlChange = viewModel::onServerUrlChange,
        onUsernameChange = viewModel::onUsernameChange,
        onPasswordChange = viewModel::onPasswordChange,
        onSignIn = viewModel::signIn,
        onCodeChange = viewModel::onCodeChange,
        onUseCode = viewModel::useCode,
        onCreateAccount = { onCreateAccount(state.serverUrl) },
    )
}
