package one.scary.bellaclaw.ui.settings.theme

import one.scary.bellaclaw.model.ThemeMode

data class ThemeSettingsUiState(
    val mode: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = false,
)
