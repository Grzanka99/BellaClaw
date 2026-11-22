package one.scary.bellaclaw.data

import one.scary.bellaclaw.data.remote.ConversationBody
import one.scary.bellaclaw.data.remote.HistoryRowBody
import one.scary.bellaclaw.data.remote.MediaBody
import one.scary.bellaclaw.model.ActivityStep
import one.scary.bellaclaw.model.FinishedList
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatIcon
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PickedImage
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.model.isNewChatId
import java.time.Instant

/**
 * Everything [ChatRepository] holds for the signed-in session, in memory only. [generation] changes with
 * every session; a network answer applies only to the generation that asked for it.
 */
internal data class ChatState(
    val generation: Int = 0,
    /** The server's list, and the chats created since it was read. */
    val conversations: List<ConversationBody> = emptyList(),
    /** Whether the list was read once. */
    val isListLoaded: Boolean = false,
    /** Loaded history by conversation key. */
    val histories: Map<String, History> = emptyMap(),
    /** Sends not yet in history, by conversation key, oldest first: posting, accepted or failed. */
    val pending: Map<String, List<PendingSend>> = emptyMap(),
    /** `reply` events by conversation key: shown once, kept for the session. */
    val replies: Map<String, List<Message>> = emptyMap(),
    val typing: Set<String> = emptySet(),
    /** The steps of the reply in progress, by conversation key, then by step id in the order they came. */
    val steps: Map<String, Map<String, ActivityStep>> = emptyMap(),
    val isStreamOpen: Boolean = false,
    /** New chat ids whose first send created their chat, to its conversation key. */
    val createdChats: Map<String, String> = emptyMap(),
) {
    /**
     * The conversation key of the app's [chatId], or null while the list has none. A new chat's sends are
     * held under its own id until it is created.
     */
    fun keyOf(chatId: String): String? {
        if (isNewChatId(chatId)) {
            return createdChats[chatId] ?: chatId
        }
        if (chatId == BELLACLAW_CHAT_ID) {
            return conversations.firstOrNull { it.kind == BELLA }?.conversationKey
        }
        return conversation(chatId)?.conversationKey
    }

    /** The listed conversation [key], or null while the list has none. */
    fun conversation(key: String): ConversationBody? = conversations.firstOrNull { it.conversationKey == key }

    fun withoutConversation(key: String) = copy(
        conversations = conversations.filter { it.conversationKey != key },
        histories = histories - key,
        pending = pending - key,
        replies = replies - key,
        typing = typing - key,
        steps = steps - key,
    )

    /** History, replies and accepted sends by time, then the sends the server has not accepted. */
    fun messagesOf(chatId: String): List<Message> {
        val key = keyOf(chatId) ?: return emptyList()
        val rows = histories[key]?.rows.orEmpty()
        val (accepted, sending) = pending[key].orEmpty().map { it.toMessage(chatId) }.partition { it.sendState == SendState.STORED }
        val stored = rows.map { it.toMessage(chatId) } + replies[key].orEmpty() + accepted
        return stored.sortedBy { it.sentAt } + sending
    }

    companion object {
        const val BELLA = "bella"
        const val PLAIN = "plain"
    }
}

/** A conversation's loaded rows, oldest first, synced to [revision]; [nextBefore] pages older rows. */
internal data class History(
    val rows: List<HistoryRowBody>,
    val revision: Long,
    val nextBefore: Long?,
)

/**
 * A message sent from this phone: [SendState.PENDING] until its post is answered, then
 * [SendState.STORED] once accepted or [SendState.FAILED]; a retry sends it again with the same [clientMessageId].
 * Its [image] shows from the picked file; [uploaded] is the upload's answer, so a retry does not upload it again.
 */
internal data class PendingSend(
    val clientMessageId: String,
    val text: String,
    val model: ModelChoice?,
    val sentAt: Instant,
    val image: PickedImage?,
    val uploaded: MediaBody? = null,
    val state: SendState = SendState.PENDING,
    val failure: String? = null,
) {
    fun toMessage(chatId: String) = Message(
        clientMessageId,
        chatId,
        Author.USER,
        text,
        sentAt,
        images = listOfNotNull(image?.let { MessageImage(null, it.mimeType, localUri = it.uri) }),
        sendState = state,
        failure = failure,
    )
}

/** The app's chat id of a conversation: the Bella conversation is always [BELLACLAW_CHAT_ID]. */
internal fun ConversationBody.chatId(): String = if (kind == ChatState.BELLA) BELLACLAW_CHAT_ID else conversationKey

internal fun HistoryRowBody.toMessage(chatId: String) = Message(
    id = id.toString(),
    chatId = chatId,
    author = if (author == "user") Author.USER else Author.ASSISTANT,
    text = text,
    sentAt = Instant.ofEpochMilli(createdAt),
    images = images.orEmpty().map { MessageImage(it.mediaId, it.mimeType) },
    steps = steps.orEmpty().map { ActivityStep(it.tool, it.label, it.detail, Instant.ofEpochMilli(it.startedAt), it.durationMs, it.failed) },
    scheduled = scheduled,
    finishedList = listFinished?.let { FinishedList(it.name, it.total) },
)

/** Derived from the key, so it stays the same across starts. */
internal fun iconOf(conversationKey: String): ChatIcon =
    ChatIcon.entries[Math.floorMod(conversationKey.hashCode(), ChatIcon.entries.size)]
