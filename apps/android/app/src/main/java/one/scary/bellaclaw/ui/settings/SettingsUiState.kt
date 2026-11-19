package one.scary.bellaclaw.ui.settings

import one.scary.bellaclaw.model.ThemeMode

data class SettingsUiState(
    val providerName: String = "",
    val mainModel: String = "",
    val personalityInChats: Boolean = true,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = false,
)
