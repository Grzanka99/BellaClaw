package one.scary.bellaclaw.ui.signin

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

/** [onClose] runs once no link waits any more: dismissed, used for a session, or lost with the process. */
@Composable
fun LinkRoute(
    onClose: () -> Unit,
    viewModel: LinkViewModel = viewModel(factory = LinkViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(state.isMissing) {
        if (state.isMissing) {
            onClose()
        }
    }
    // Every way out drops the link, so the next link opens this screen again.
    BackHandler(onBack = viewModel::dismiss)
    LinkScreen(
        state = state,
        onDismiss = viewModel::dismiss,
        onCheck = viewModel::check,
        onSignInLinked = viewModel::signInLinked,
        onCreateAccountChange = viewModel::onCreateAccountChange,
        onUsernameChange = viewModel::onUsernameChange,
        onPasswordChange = viewModel::onPasswordChange,
        onSubmitAccount = viewModel::submitAccount,
        onConnect = viewModel::connect,
    )
}
