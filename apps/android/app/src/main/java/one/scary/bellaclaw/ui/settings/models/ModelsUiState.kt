package one.scary.bellaclaw.ui.settings.models

import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.Provider

data class RoleRow(
    val role: ModelRole,
    val model: String,
    val effort: Effort,
    /** True when the role differs from the provider's default. */
    val isCustom: Boolean,
)

/** The role sheet's unsaved choice; Save stores it, Reset restores the default. */
data class RoleEditorState(
    val role: ModelRole,
    val models: List<String>,
    val model: String,
    val effort: Effort,
)

data class ModelsUiState(
    val providers: List<Provider> = emptyList(),
    val providerId: String = "",
    val roles: List<RoleRow> = emptyList(),
    val editor: RoleEditorState? = null,
) {
    val provider: Provider?
        get() = providers.firstOrNull { it.id == providerId }
}
