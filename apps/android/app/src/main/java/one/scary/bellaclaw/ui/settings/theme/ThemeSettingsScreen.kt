package one.scary.bellaclaw.ui.settings.theme

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.components.label
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThemeSettingsScreen(
    state: ThemeSettingsUiState,
    onBack: () -> Unit,
    onSelectMode: (ThemeMode) -> Unit,
    onDynamicColorChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val transparent = ListItemDefaults.colors(containerColor = Color.Transparent)
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.theme_title)) },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).verticalScroll(rememberScrollState())) {
            SectionHeader(stringResource(R.string.theme_mode))
            Column(modifier = Modifier.selectableGroup()) {
                ThemeMode.entries.forEach { mode ->
                    ListItem(
                        headlineContent = { Text(stringResource(mode.label)) },
                        leadingContent = { RadioButton(selected = mode == state.mode, onClick = null) },
                        colors = transparent,
                        modifier = Modifier.selectable(
                            selected = mode == state.mode,
                            onClick = { onSelectMode(mode) },
                            role = Role.RadioButton,
                        ),
                    )
                }
            }
            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            ListItem(
                headlineContent = { Text(stringResource(R.string.theme_dynamic_color)) },
                supportingContent = { Text(stringResource(R.string.theme_dynamic_color_summary)) },
                trailingContent = { Switch(checked = state.dynamicColor, onCheckedChange = null) },
                colors = transparent,
                modifier = Modifier.toggleable(
                    value = state.dynamicColor,
                    onValueChange = onDynamicColorChange,
                    role = Role.Switch,
                ),
            )
        }
    }
}

@Preview
@Composable
private fun ThemeSettingsScreenPreview() {
    BellaClawTheme {
        ThemeSettingsScreen(
            state = ThemeSettingsUiState(ThemeMode.SYSTEM, dynamicColor = false),
            onBack = {},
            onSelectMode = {},
            onDynamicColorChange = {},
        )
    }
}
