package one.scary.bellaclaw.ui.signin

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RegisterScreen(
    state: RegisterUiState,
    onBack: () -> Unit,
    onServerUrlChange: (String) -> Unit,
    onUsernameChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onActivationCodeChange: (String) -> Unit,
    onRegister: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.register_title)) },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        SignInColumn(padding) {
            Text(stringResource(R.string.register_intro), style = MaterialTheme.typography.bodyLarge)
            ServerUrlField(state.serverUrl, onServerUrlChange, state.error, enabled = !state.isLoading)
            UsernameField(state.username, onUsernameChange, enabled = !state.isLoading)
            SecretField(state.password, onPasswordChange, stringResource(R.string.label_password), enabled = !state.isLoading)
            SecretField(
                state.activationCode,
                onActivationCodeChange,
                stringResource(R.string.label_activation_code),
                enabled = !state.isLoading,
            )
            RequestErrorText(state.error)
            SubmitButton(stringResource(R.string.action_create_account), onRegister, state.canRegister, state.isLoading)
        }
    }
}

@Preview
@Composable
private fun RegisterScreenPreview() {
    BellaClawTheme {
        RegisterScreen(
            state = RegisterUiState(
                serverUrl = "https://bellaclaw.example.com",
                username = "ada",
                error = AccountError.Server(400, "Wrong activation code"),
            ),
            onBack = {},
            onServerUrlChange = {},
            onUsernameChange = {},
            onPasswordChange = {},
            onActivationCodeChange = {},
            onRegister = {},
        )
    }
}
