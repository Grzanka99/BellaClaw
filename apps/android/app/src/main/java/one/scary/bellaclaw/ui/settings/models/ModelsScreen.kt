package one.scary.bellaclaw.ui.settings.models

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.data.sample.SampleSettings
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.components.OptionDropdown
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.components.SettingsRow
import one.scary.bellaclaw.ui.components.label
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelsScreen(
    state: ModelsUiState,
    onBack: () -> Unit,
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
        Column(modifier = Modifier.padding(padding).verticalScroll(rememberScrollState())) {
            state.provider?.let { provider ->
                OptionDropdown(
                    label = stringResource(R.string.label_provider),
                    options = state.providers,
                    selected = provider,
                    optionText = { it.name },
                    onSelect = { onSelectProvider(it.id) },
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            SectionHeader(stringResource(R.string.models_roles))
            state.roles.forEach { row ->
                SettingsRow(
                    title = { RoleTitle(row) },
                    subtitle = stringResource(R.string.model_and_effort, row.model, stringResource(row.effort.label)),
                    onClick = { onOpenRole(row.role) },
                )
            }
        }
    }
    state.editor?.let { editor ->
        RoleEditorSheet(state = editor, events = editorEvents)
    }
}

@Composable
private fun RoleTitle(row: RoleRow) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(row.role.label))
        if (row.isCustom) {
            Spacer(Modifier.width(8.dp))
            Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
                Text(
                    text = stringResource(R.string.models_custom),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Preview
@Composable
private fun ModelsScreenPreview() {
    BellaClawTheme {
        ModelsScreen(
            state = ModelsUiState(
                providers = SampleSettings.providers,
                providerId = "opencode-go",
                roles = listOf(
                    RoleRow(ModelRole.UTILITY, "Claude Haiku 5.5", Effort.LOW, false),
                    RoleRow(ModelRole.SPECIALIST_ACCURATE, "Kimi K3.1 Pro", Effort.HIGH, true),
                ),
            ),
            onBack = {},
            onSelectProvider = {},
            onOpenRole = {},
            editorEvents = RoleEditorEvents({}, {}, {}, {}, {}),
        )
    }
}
