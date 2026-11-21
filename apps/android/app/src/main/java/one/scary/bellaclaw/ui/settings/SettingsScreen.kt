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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.components.BackTopBar
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.components.SettingsRow
import one.scary.bellaclaw.ui.components.label
import one.scary.bellaclaw.ui.components.text
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@Composable
fun SettingsScreen(
    state: SettingsUiState,
    onBack: () -> Unit,
    onOpenModels: () -> Unit,
    onOpenPersonality: () -> Unit,
    onOpenTheme: () -> Unit,
    onOpenNotifications: () -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            BackTopBar(stringResource(R.string.settings_title), onBack)
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).verticalScroll(rememberScrollState())) {
            SectionHeader(stringResource(R.string.bellaclaw_name))
            SettingsRow(
                icon = Icons.Outlined.Psychology,
                title = { Text(stringResource(R.string.models_title)) },
                subtitle = when (val models = state.models) {
                    Loadable.Loading -> stringResource(R.string.settings_loading)
                    is Loadable.Failed -> models.error.text()
                    is Loadable.Loaded -> stringResource(R.string.models_summary, models.value.provider, models.value.mainModel)
                },
                onClick = onOpenModels,
            )
            SettingsRow(
                icon = Icons.Outlined.Face,
                title = { Text(stringResource(R.string.personality_title)) },
                subtitle = when (val inChats = state.personalityInChats) {
                    Loadable.Loading -> stringResource(R.string.settings_loading)
                    is Loadable.Failed -> inChats.error.text()
                    is Loadable.Loaded -> if (inChats.value) {
                        stringResource(R.string.personality_summary_shared)
                    } else {
                        stringResource(R.string.personality_summary_separate)
                    }
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
            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            AccountSection(state, onSignOut)
        }
    }
}

@Preview
@Composable
private fun SettingsScreenPreview() {
    BellaClawTheme {
        SettingsScreen(
            state = SettingsUiState(
                Loadable.Loaded(ModelsSummary("opencode-go", "Kimi K3.1 Pro")),
                Loadable.Loaded(true),
                ThemeMode.SYSTEM,
                true,
                username = "ada",
                serverUrl = "https://bellaclaw.example.com",
            ),
            onBack = {},
            onOpenModels = {},
            onOpenPersonality = {},
            onOpenTheme = {},
            onOpenNotifications = {},
            onSignOut = {},
        )
    }
}
