package one.scary.bellaclaw.ui.settings.models

import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.AiModel
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole

/** [model] is the model's name; [effort] null is the model's own default. */
data class RoleRow(
    val role: ModelRole,
    val model: String,
    val effort: Effort?,
)

/** The role sheet's unsaved choice of one of [models] by id; Save sends it, Reset restores the provider's default. */
data class RoleEditorState(
    val role: ModelRole,
    val models: List<AiModel>,
    val model: String,
    val effort: Effort?,
) {
    val selectedModel: AiModel?
        get() = models.firstOrNull { it.id == model }

    /** The model's own default (null), then the efforts the model supports. */
    val efforts: List<Effort?>
        get() = listOf(null) + selectedModel?.efforts.orEmpty()
}

data class ModelsUiState(
    val isLoading: Boolean = true,
    val loadError: AccountError? = null,
    val providers: List<String> = emptyList(),
    val providerId: String = "",
    val roles: List<RoleRow> = emptyList(),
    /** True while the server verifies a change; the screen takes no other. */
    val isChanging: Boolean = false,
    /** Why the server refused the last change. */
    val changeError: AccountError? = null,
    val editor: RoleEditorState? = null,
)
