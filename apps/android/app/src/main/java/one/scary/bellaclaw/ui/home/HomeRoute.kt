package one.scary.bellaclaw.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.withResumed

@Composable
fun HomeRoute(
    onOpenChat: (String) -> Unit,
    onOpenSettings: () -> Unit,
    viewModel: HomeViewModel = viewModel(factory = HomeViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val createdChatId = state.createdChatId
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Opens the chat once this entry is resumed, so the navigation is not dropped, and acknowledges it in the same step.
    LaunchedEffect(createdChatId) {
        if (createdChatId != null) {
            lifecycle.withResumed {
                onOpenChat(createdChatId)
                viewModel.onNewChatOpened()
            }
        }
    }
    HomeScreen(
        state = state,
        onOpenChat = onOpenChat,
        onNewChat = viewModel::newChat,
        onOpenSettings = onOpenSettings,
    )
}
