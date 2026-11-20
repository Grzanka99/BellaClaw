package one.scary.bellaclaw.ui.home

import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatIcon
import java.time.Instant

/**
 * One row of the chat list. [preview] and [lastActivity] are null for a chat with no messages (only
 * BellaClaw's: a plain chat with none is not listed); [preview] is empty when the newest message is images only.
 */
sealed interface ChatSummary {
    val id: String
    val preview: String?
    val lastActivity: Instant?

    /** The newest row is newer than what was seen with the chat open. */
    val isUnread: Boolean
}

data class BellaClawSummary(
    override val id: String,
    override val preview: String?,
    override val lastActivity: Instant?,
    override val isUnread: Boolean = false,
) : ChatSummary

/** [title] is null for a new chat. */
data class PlainChatSummary(
    override val id: String,
    val title: String?,
    val icon: ChatIcon,
    override val preview: String?,
    override val lastActivity: Instant?,
    override val isUnread: Boolean = false,
) : ChatSummary

data class HomeUiState(
    val bellaClaw: BellaClawSummary = BellaClawSummary(BELLACLAW_CHAT_ID, preview = null, lastActivity = null),
    val chats: List<PlainChatSummary> = emptyList(),
)
