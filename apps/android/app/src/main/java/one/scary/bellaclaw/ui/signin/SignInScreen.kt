package one.scary.bellaclaw.ui.signin

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.ui.components.label
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignInScreen(
    state: SignInUiState,
    onServerUrlChange: (String) -> Unit,
    onUsernameChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSignIn: () -> Unit,
    onCodeChange: (String) -> Unit,
    onUseCode: () -> Unit,
    onCreateAccount: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.sign_in_title)) }) },
    ) { padding ->
        SignInColumn(padding) {
            Text(stringResource(R.string.sign_in_intro), style = MaterialTheme.typography.bodyLarge)
            ServerUrlField(state.serverUrl, onServerUrlChange, state.error, enabled = !state.isLoading)
            UsernameField(state.username, onUsernameChange, enabled = !state.isLoading)
            SecretField(state.password, onPasswordChange, stringResource(R.string.label_password), enabled = !state.isLoading)
            RequestErrorText(state.error)
            SubmitButton(stringResource(R.string.action_sign_in), onSignIn, state.canSignIn, state.isLoading)
            TextButton(onClick = onCreateAccount, enabled = !state.isLoading, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_go_to_create_account))
            }
            HorizontalDivider()
            Text(stringResource(R.string.sign_in_with_chat), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.sign_in_with_chat_help), style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(
                value = state.code,
                onValueChange = onCodeChange,
                label = { Text(stringResource(R.string.label_login_code)) },
                isError = state.codeProblem != null,
                supportingText = state.codeProblem?.let { { Text(stringResource(it.label)) } },
                singleLine = true,
                enabled = !state.isLoading,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(onClick = onUseCode, enabled = state.canUseCode, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_use_code))
            }
        }
    }
}

@Preview
@Composable
private fun SignInScreenPreview() {
    BellaClawTheme {
        SignInScreen(
            state = SignInUiState(
                serverUrl = "https://bellaclaw.example.com",
                username = "ada",
                error = AccountError.Server(401, "Wrong username or password"),
                code = "bellaclaw://nope",
                codeProblem = LoginLinkProblem.NotALoginLink,
            ),
            onServerUrlChange = {},
            onUsernameChange = {},
            onPasswordChange = {},
            onSignIn = {},
            onCodeChange = {},
            onUseCode = {},
            onCreateAccount = {},
        )
    }
}
