package one.scary.bellaclaw.ui.settings

import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.ThemeMode

data class SettingsUiState(
    val providerName: String = "",
    val mainModel: String = "",
    val personalityInChats: Boolean = true,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = false,
    val username: String = "",
    val serverUrl: String = "",
    val isSigningOut: Boolean = false,
    val signOutError: AccountError? = null,
)
