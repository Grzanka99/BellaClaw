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

/**
 * A row of history: a message or a display row. [author] is `user` or `assistant`; [createdAt] epoch ms.
 * An assistant row has the [steps] of its reply, by start, when there were any; [scheduled] marks a
 * delivery of a scheduled job, such as a reminder or an automation's output; [listFinished] marks the row
 * written when a list's last item was ticked.
 */
@Serializable
data class HistoryRowBody(
    val id: Long,
    val author: String,
    val text: String,
    val createdAt: Long,
    val clientMessageId: String? = null,
    val images: List<HistoryImageBody>? = null,
    val steps: List<StepBody>? = null,
    val scheduled: Boolean,
    val listFinished: ListFinishedBody? = null,
)

/** A finished step of a reply; [startedAt] epoch ms. */
@Serializable
data class StepBody(
    val tool: String,
    val label: String,
    val detail: String,
    val startedAt: Long,
    val durationMs: Long,
    val failed: Boolean,
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

/** POST /api/conversations/{key}/messages; [model] only for a plain chat; [images] as their uploads answered. */
@Serializable
class SendBody(val clientMessageId: String, val text: String, val model: ModelBody? = null, val images: List<MediaBody>? = null)

/** The answer of POST /api/conversations/{key}/media: the uploaded image, as a send names it. */
@Serializable
data class MediaBody(val id: String, val mimeType: String)

/** A plain chat's model for one send; [effort] in the server's lower-case names. */
@Serializable
data class ModelBody(val provider: String, val model: String, val effort: String)

/** POST /api/conversations: the new plain chat. */
@Serializable
data class ConversationCreatedBody(val conversationKey: String)

/**
 * The data of one event of GET /api/stream; which fields it has depends on the event's type. A plain
 * class: a `reply`'s [text] can hold a sign-in link. A `step` has [stepId], [tool], [label], [detail], [state]
 * (`started`, then `completed` or `failed` with [durationMs]) and [startedAt], epoch ms.
 */
@Serializable
class StreamEventBody(
    val conversationKey: String? = null,
    val typing: Boolean = false,
    val text: String? = null,
    val stepId: String? = null,
    val tool: String? = null,
    val label: String? = null,
    val detail: String? = null,
    val state: String? = null,
    val startedAt: Long? = null,
    val durationMs: Long? = null,
)
