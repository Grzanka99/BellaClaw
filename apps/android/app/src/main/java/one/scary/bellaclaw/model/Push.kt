package one.scary.bellaclaw.model

/**
 * A new message, as a push brings it: the row [messageId] of conversation [conversationKey] at the
 * conversation's [revision]. [text] is the row's text, or only its start when [truncated].
 */
data class AppPush(
    val conversationKey: String,
    val messageId: Long,
    val revision: Long,
    val text: String,
    val truncated: Boolean,
)
