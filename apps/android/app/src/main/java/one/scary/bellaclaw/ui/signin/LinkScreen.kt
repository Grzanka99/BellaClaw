package one.scary.bellaclaw.ui.signin

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import one.scary.bellaclaw.R
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LinkScreen(
    state: LinkUiState,
    onDismiss: () -> Unit,
    onCheck: () -> Unit,
    onSignInLinked: () -> Unit,
    onCreateAccountChange: (Boolean) -> Unit,
    onUsernameChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSubmitAccount: () -> Unit,
    onConnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.link_title)) },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.action_cancel))
                    }
                },
            )
        },
    ) { padding ->
        SignInColumn(padding) {
            when (state.step) {
                LinkStep.MISSING -> Unit
                LinkStep.UNUSABLE -> UnusableLink(state, onDismiss)
                LinkStep.CONFIRM -> ConfirmLink(state, onCheck, onDismiss)
                LinkStep.OTHER_SERVER -> OtherServer(state, onDismiss)
                LinkStep.INVALID -> InvalidLink(onDismiss)
                LinkStep.LINKED -> LinkedChat(state, onSignInLinked)
                LinkStep.UNLINKED -> UnlinkedChat(
                    state,
                    onCreateAccountChange,
                    onUsernameChange,
                    onPasswordChange,
                    onSubmitAccount,
                )
                LinkStep.CONNECT -> ConnectChat(state, onConnect, onDismiss)
                LinkStep.ALREADY_CONNECTED -> ChatOutcome(state, R.string.link_already_connected, onDismiss)
                LinkStep.OTHER_ACCOUNT -> ChatOutcome(state, R.string.link_other_account, onDismiss)
                LinkStep.CONNECTED -> ChatOutcome(state, R.string.link_connected, onDismiss)
            }
        }
    }
}

@Preview
@Composable
private fun LinkConfirmPreview() {
    BellaClawTheme {
        LinkPreview(LinkUiState(step = LinkStep.CONFIRM, serverUrl = "https://bellaclaw.example.com"))
    }
}

@Preview
@Composable
private fun LinkUnlinkedPreview() {
    BellaClawTheme {
        LinkPreview(
            LinkUiState(
                step = LinkStep.UNLINKED,
                serverUrl = "https://bellaclaw.example.com",
                chat = "Signal +48123456789",
                username = "ada",
            ),
        )
    }
}

@Composable
private fun LinkPreview(state: LinkUiState) {
    LinkScreen(
        state = state,
        onDismiss = {},
        onCheck = {},
        onSignInLinked = {},
        onCreateAccountChange = {},
        onUsernameChange = {},
        onPasswordChange = {},
        onSubmitAccount = {},
        onConnect = {},
    )
}
