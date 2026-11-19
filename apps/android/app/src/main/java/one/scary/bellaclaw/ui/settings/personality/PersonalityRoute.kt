package one.scary.bellaclaw.ui.settings.personality

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.withResumed

@Composable
fun PersonalityRoute(
    onBack: () -> Unit,
    viewModel: PersonalityViewModel = viewModel(factory = PersonalityViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Goes back once this entry is resumed, so the navigation is not dropped, and acknowledges it in the same step.
    LaunchedEffect(state.isSaved) {
        if (state.isSaved) {
            lifecycle.withResumed {
                onBack()
                viewModel.onSaveHandled()
            }
        }
    }
    PersonalityScreen(
        state = state,
        onBack = onBack,
        onSave = viewModel::save,
        onBellaClawChange = viewModel::onBellaClawChange,
        onUseInChatsChange = viewModel::onUseInChatsChange,
        onChatsChange = viewModel::onChatsChange,
    )
}
