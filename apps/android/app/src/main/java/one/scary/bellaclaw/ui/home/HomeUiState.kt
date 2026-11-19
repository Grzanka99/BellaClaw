package one.scary.bellaclaw.ui.home

import one.scary.bellaclaw.model.ChatIcon
import java.time.Instant

/** One row of the chat list. [preview] and [lastActivity] are null for a chat with no messages. */
sealed interface ChatSummary {
    val id: String
    val preview: String?
    val lastActivity: Instant?
}

data class BellaClawSummary(
    override val id: String,
    override val preview: String?,
    override val lastActivity: Instant?,
) : ChatSummary

/** [title] is null for a new chat. */
data class PlainChatSummary(
    override val id: String,
    val title: String?,
    val icon: ChatIcon,
    override val preview: String?,
    override val lastActivity: Instant?,
) : ChatSummary

data class HomeUiState(
    val bellaClaw: BellaClawSummary? = null,
    val chats: List<PlainChatSummary> = emptyList(),
    /** Set once a new chat exists; the screen opens it and reports back with [HomeViewModel.onNewChatOpened]. */
    val createdChatId: String? = null,
)
