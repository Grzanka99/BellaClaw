package one.scary.bellaclaw.data.remote

import kotlinx.serialization.Serializable

// Request and answer bodies of the gateway's conversation routes and its live stream.

/** GET /api/conversations: the Bella conversation first, then the plain chats, the latest active first. */
@Serializable
data class ConversationsBody(val conversations: List<ConversationBody>)

/** [kind] is `bella` or `plain`; [title] stays null until the server writes one; [lastMessage] is the newest row. */
@Serializable
data class ConversationBody(
    val conversationKey: String,
    val kind: String,
    val revision: Long,
    val rewriteRevision: Long,
    val title: String? = null,
    val lastMessage: HistoryRowBody? = null,
)

/** A row of history: a message or a display row. [author] is `user` or `assistant`; [createdAt] epoch ms. */
@Serializable
data class HistoryRowBody(
    val id: Long,
    val author: String,
    val text: String,
    val createdAt: Long,
    val clientMessageId: String? = null,
    val images: List<HistoryImageBody>? = null,
)

/** [mediaId] is null for an image the server does not keep. */
@Serializable
data class HistoryImageBody(val mediaId: String? = null, val mimeType: String)

/** GET /api/conversations/{key}/messages: rows oldest first, and the cursors of the next pages. */
@Serializable
data class HistoryBody(
    val revision: Long,
    val rewriteRevision: Long,
    val messages: List<HistoryRowBody>,
    val nextBefore: Long? = null,
    val nextAfter: Long? = null,
)

/** POST /api/conversations/{key}/messages; [model] only for a plain chat. */
@Serializable
class SendBody(val clientMessageId: String, val text: String, val model: ModelBody? = null)

/** A plain chat's model for one send; [effort] in the server's lower-case names. */
@Serializable
data class ModelBody(val provider: String, val model: String, val effort: String)

/** POST /api/conversations: the new plain chat. */
@Serializable
data class ConversationCreatedBody(val conversationKey: String)

/**
 * The data of one event of GET /api/stream; which fields it has depends on the event's type. A plain
 * class: a `reply`'s [text] can hold a sign-in link.
 */
@Serializable
class StreamEventBody(
    val conversationKey: String? = null,
    val typing: Boolean = false,
    val text: String? = null,
)
