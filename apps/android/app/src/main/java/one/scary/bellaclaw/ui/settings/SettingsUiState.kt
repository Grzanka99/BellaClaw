package one.scary.bellaclaw.ui.settings

import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.ThemeMode

/** The provider and the Main role's model name. */
data class ModelsSummary(val provider: String, val mainModel: String)

data class SettingsUiState(
    val models: Loadable<ModelsSummary> = Loadable.Loading,
    val personalityInChats: Loadable<Boolean> = Loadable.Loading,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = false,
    val username: String = "",
    val serverUrl: String = "",
    val isSigningOut: Boolean = false,
    val signOutError: AccountError? = null,
)
