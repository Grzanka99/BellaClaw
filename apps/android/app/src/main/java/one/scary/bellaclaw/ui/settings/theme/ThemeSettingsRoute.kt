package one.scary.bellaclaw.ui.settings.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

@Composable
fun ThemeSettingsRoute(
    onBack: () -> Unit,
    viewModel: ThemeSettingsViewModel = viewModel(factory = ThemeSettingsViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    ThemeSettingsScreen(
        state = state,
        onBack = onBack,
        onSelectMode = viewModel::selectMode,
        onDynamicColorChange = viewModel::setDynamicColor,
    )
}
