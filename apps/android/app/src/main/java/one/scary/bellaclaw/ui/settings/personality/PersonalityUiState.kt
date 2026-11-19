package one.scary.bellaclaw.ui.settings.personality

data class PersonalityUiState(
    val bellaClaw: String = "",
    val useInChats: Boolean = true,
    val chats: String = "",
    /** True when the edits differ from what is saved. */
    val canSave: Boolean = false,
    /** Set once the edits are stored; the screen closes and reports back with [PersonalityViewModel.onSaveHandled]. */
    val isSaved: Boolean = false,
)
