package one.scary.bellaclaw.ui.settings.models

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.components.LoadFailedContent
import one.scary.bellaclaw.ui.components.LoadingContent
import one.scary.bellaclaw.ui.components.OptionDropdown
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.components.SettingsRow
import one.scary.bellaclaw.ui.components.label
import one.scary.bellaclaw.ui.components.text
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelsScreen(
    state: ModelsUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onSelectProvider: (String) -> Unit,
    onOpenRole: (ModelRole) -> Unit,
    editorEvents: RoleEditorEvents,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.models_title)) },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        val loadError = state.loadError
        if (state.isLoading) {
            LoadingContent(Modifier.padding(padding))
        } else if (loadError != null) {
            LoadFailedContent(loadError, onRetry, Modifier.padding(padding))
        } else {
            Column(modifier = Modifier.padding(padding).verticalScroll(rememberScrollState())) {
                ChangeStatus(state)
                OptionDropdown(
                    label = stringResource(R.string.label_provider),
                    options = state.providers,
                    selected = state.providerId,
                    optionText = { it },
                    onSelect = onSelectProvider,
                    enabled = !state.isChanging,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
                SectionHeader(stringResource(R.string.models_roles))
                state.roles.forEach { row ->
                    SettingsRow(
                        title = { Text(stringResource(row.role.label)) },
                        subtitle = stringResource(R.string.model_and_effort, row.model, stringResource(effortLabel(row.effort))),
                        onClick = { onOpenRole(row.role) },
                    )
                }
            }
        }
    }
    state.editor?.let { editor ->
        RoleEditorSheet(state = editor, events = editorEvents)
    }
}

/** A change the server is verifying, or why it refused the last one. */
@Composable
private fun ChangeStatus(state: ModelsUiState) {
    val error = state.changeError
    if (state.isChanging) {
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        Text(
            stringResource(R.string.models_verifying),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    } else if (error != null) {
        Text(
            error.text(),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Preview
@Composable
private fun ModelsScreenPreview() {
    BellaClawTheme {
        ModelsScreen(
            state = ModelsUiState(
                isLoading = false,
                providers = listOf("opencode-go", "openai-codex"),
                providerId = "opencode-go",
                roles = listOf(
                    RoleRow(ModelRole.UTILITY, "Claude Haiku 5.5", null),
                    RoleRow(ModelRole.SPECIALIST_ACCURATE, "Kimi K3.1 Pro", Effort.HIGH),
                ),
                isChanging = true,
            ),
            onBack = {},
            onRetry = {},
            onSelectProvider = {},
            onOpenRole = {},
            editorEvents = RoleEditorEvents({}, {}, {}, {}, {}),
        )
    }
}
