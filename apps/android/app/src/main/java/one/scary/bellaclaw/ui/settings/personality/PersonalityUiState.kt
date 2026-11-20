package one.scary.bellaclaw.ui.settings.personality

import one.scary.bellaclaw.model.AccountError

data class PersonalityUiState(
    val isLoading: Boolean = true,
    val loadError: AccountError? = null,
    val bellaClaw: String = "",
    val useInChats: Boolean = true,
    val chats: String = "",
    /** True when the edits differ from what is saved and no save is running. */
    val canSave: Boolean = false,
    val isSaving: Boolean = false,
    /** Why the server refused the last save; the edits stay. */
    val saveError: AccountError? = null,
    /**
     * Set once the edits are stored; the screen closes and reports back with [PersonalityViewModel.onSaveHandled].
     * The fields take no input while [isSaving] or this is set.
     */
    val isSaved: Boolean = false,
)
