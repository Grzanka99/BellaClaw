package one.scary.bellaclaw.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Face
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.components.SettingsRow
import one.scary.bellaclaw.ui.components.label
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: SettingsUiState,
    onBack: () -> Unit,
    onOpenModels: () -> Unit,
    onOpenPersonality: () -> Unit,
    onOpenTheme: () -> Unit,
    onOpenNotifications: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).verticalScroll(rememberScrollState())) {
            SectionHeader(stringResource(R.string.bellaclaw_name))
            SettingsRow(
                icon = Icons.Outlined.Psychology,
                title = { Text(stringResource(R.string.models_title)) },
                subtitle = stringResource(R.string.models_summary, state.providerName, state.mainModel),
                onClick = onOpenModels,
            )
            SettingsRow(
                icon = Icons.Outlined.Face,
                title = { Text(stringResource(R.string.personality_title)) },
                subtitle = if (state.personalityInChats) {
                    stringResource(R.string.personality_summary_shared)
                } else {
                    stringResource(R.string.personality_summary_separate)
                },
                onClick = onOpenPersonality,
            )
            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            SectionHeader(stringResource(R.string.settings_app))
            val themeMode = stringResource(state.themeMode.label)
            SettingsRow(
                icon = Icons.Outlined.Palette,
                title = { Text(stringResource(R.string.theme_title)) },
                subtitle = if (state.dynamicColor) {
                    stringResource(R.string.theme_summary_dynamic, themeMode)
                } else {
                    themeMode
                },
                onClick = onOpenTheme,
            )
            SettingsRow(
                icon = Icons.Outlined.Notifications,
                title = { Text(stringResource(R.string.notifications_title)) },
                subtitle = stringResource(R.string.notifications_summary),
                onClick = onOpenNotifications,
            )
        }
    }
}

@Preview
@Composable
private fun SettingsScreenPreview() {
    BellaClawTheme {
        SettingsScreen(
            state = SettingsUiState("OpenCode Go", "Kimi K3.1 Pro", true, ThemeMode.SYSTEM, true),
            onBack = {},
            onOpenModels = {},
            onOpenPersonality = {},
            onOpenTheme = {},
            onOpenNotifications = {},
        )
    }
}
