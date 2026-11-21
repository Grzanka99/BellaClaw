package one.scary.bellaclaw.ui.signin

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import one.scary.bellaclaw.R
import one.scary.bellaclaw.ui.components.label

// The content of each step of the link confirmation.

@Composable
fun UnusableLink(state: LinkUiState, onDismiss: () -> Unit) {
    Text(stringResource(R.string.link_unusable), style = MaterialTheme.typography.bodyLarge)
    state.problem?.let { Text(stringResource(it.label), color = MaterialTheme.colorScheme.error) }
    CloseButton(onDismiss)
}

/** The server is shown before anything is sent, and the chat before anything signs in or connects: a link can come from anyone. */
@Composable
fun ConfirmLink(state: LinkUiState, onCheck: () -> Unit, onDismiss: () -> Unit) {
    Text(stringResource(R.string.link_confirm), style = MaterialTheme.typography.bodyLarge)
    ServerName(state.serverUrl)
    Text(stringResource(R.string.link_confirm_help), style = MaterialTheme.typography.bodyMedium)
    RequestErrorText(state.error)
    SubmitButton(stringResource(R.string.action_continue), onCheck, enabled = true, isLoading = state.isLoading)
    CloseButton(onDismiss, R.string.action_cancel)
}

@Composable
fun OtherServer(state: LinkUiState, onDismiss: () -> Unit) {
    ServerName(state.serverUrl)
    Text(
        stringResource(R.string.link_other_server, state.accountName, state.signedInServer),
        style = MaterialTheme.typography.bodyLarge,
    )
    CloseButton(onDismiss)
}

@Composable
fun InvalidLink(onDismiss: () -> Unit) {
    Text(stringResource(R.string.link_invalid), style = MaterialTheme.typography.bodyLarge)
    CloseButton(onDismiss)
}

@Composable
fun LinkedChat(state: LinkUiState, onSignIn: () -> Unit) {
    ServerName(state.serverUrl)
    Text(stringResource(R.string.link_linked, state.chat, state.accountName), style = MaterialTheme.typography.bodyLarge)
    RequestErrorText(state.error)
    SubmitButton(stringResource(R.string.action_sign_in), onSignIn, enabled = true, isLoading = state.isLoading)
}

@Composable
fun ConnectChat(state: LinkUiState, onConnect: () -> Unit, onDismiss: () -> Unit) {
    ServerName(state.serverUrl)
    Text(stringResource(R.string.link_connect, state.chat, state.accountName), style = MaterialTheme.typography.bodyLarge)
    RequestErrorText(state.error)
    SubmitButton(stringResource(R.string.action_connect), onConnect, enabled = true, isLoading = state.isLoading)
    CloseButton(onDismiss, R.string.action_cancel)
}

/** A step past the connect offer with nothing left to do: [text] takes the chat and the signed-in account. */
@Composable
fun ChatOutcome(state: LinkUiState, @StringRes text: Int, onDismiss: () -> Unit) {
    ServerName(state.serverUrl)
    Text(stringResource(text, state.chat, state.accountName), style = MaterialTheme.typography.bodyLarge)
    SubmitButton(stringResource(R.string.action_done), onDismiss, enabled = true, isLoading = false)
}

@Composable
fun UnlinkedChat(
    state: LinkUiState,
    onCreateAccountChange: (Boolean) -> Unit,
    onUsernameChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    ServerName(state.serverUrl)
    Text(stringResource(R.string.link_unlinked, state.chat), style = MaterialTheme.typography.bodyLarge)
    UsernameField(state.username, onUsernameChange, enabled = !state.isLoading)
    SecretField(state.password, onPasswordChange, stringResource(R.string.label_password), enabled = !state.isLoading)
    RequestErrorText(state.error)
    if (state.createAccount) {
        SubmitButton(stringResource(R.string.action_create_account), onSubmit, state.canSubmitAccount, state.isLoading)
        TextButton(onClick = { onCreateAccountChange(false) }, enabled = !state.isLoading, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.action_i_have_account))
        }
    } else {
        SubmitButton(stringResource(R.string.action_sign_in), onSubmit, state.canSubmitAccount, state.isLoading)
        TextButton(onClick = { onCreateAccountChange(true) }, enabled = !state.isLoading, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.action_create_account))
        }
    }
}

@Composable
private fun ServerName(serverUrl: String) {
    Text(serverUrl, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun CloseButton(onDismiss: () -> Unit, @StringRes label: Int = R.string.action_close) {
    OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(label))
    }
}
