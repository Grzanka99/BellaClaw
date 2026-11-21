package one.scary.bellaclaw.ui.settings.models

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

@Composable
fun ModelsRoute(
    onBack: () -> Unit,
    viewModel: ModelsViewModel = viewModel(factory = ModelsViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    ModelsScreen(
        state = state,
        onBack = onBack,
        onRetry = viewModel::retry,
        onSelectProvider = viewModel::selectProvider,
        onOpenRole = viewModel::openRole,
        editorEvents = RoleEditorEvents(
            onModel = viewModel::onEditorModel,
            onEffort = viewModel::onEditorEffort,
            onServiceTier = viewModel::onEditorServiceTier,
            onSave = viewModel::saveRole,
            onReset = viewModel::resetRole,
            onDismiss = viewModel::dismissEditor,
        ),
    )
}
