package one.scary.bellaclaw.data

import one.scary.bellaclaw.data.remote.CommandBody
import one.scary.bellaclaw.data.remote.ConversationBody
import one.scary.bellaclaw.data.remote.HistoryRowBody
import one.scary.bellaclaw.data.remote.MediaBody
import one.scary.bellaclaw.model.ActivityStep
import one.scary.bellaclaw.model.FinishedList
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatIcon
import one.scary.bellaclaw.model.CommandEntry
import one.scary.bellaclaw.model.CommandRow
import one.scary.bellaclaw.model.CommandRun
import one.scary.bellaclaw.model.CommandState
import one.scary.bellaclaw.model.CommandStatus
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
    /** The command catalog as last read; empty until read. */
    val commands: List<CommandEntry> = emptyList(),
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

    /**
     * History, replies and accepted sends by time, then the sends the server has not accepted. A reply to a
     * command stands in for the run's stored reply row, which holds only its outcome. In BellaClaw's chat a
     * send of a catalog command is a pending run of it.
     */
    fun messagesOf(chatId: String): List<Message> {
        val key = keyOf(chatId) ?: return emptyList()
        val chatReplies = replies[key].orEmpty()
        val repliedRuns = chatReplies.mapNotNullTo(HashSet()) { it.command?.runId }
        val rows = histories[key]?.rows.orEmpty().map { it.toMessage(chatId) }.filter { row ->
            val runId = row.command?.runId
            row.author == Author.USER || runId == null || runId !in repliedRuns
        }
        val catalog = if (chatId == BELLACLAW_CHAT_ID) commands else emptyList()
        val (accepted, sending) = pending[key].orEmpty().map { it.toMessage(chatId, catalog) }.partition { it.sendState == SendState.STORED }
        val stored = rows + chatReplies + accepted
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
    /** A send whose first word is a command of [commands] is a run of it until history has the send. */
    fun toMessage(chatId: String, commands: List<CommandEntry>): Message {
        val word = text.split(WHITESPACE, limit = 2).first()
        val name = word.removePrefix("!").lowercase()
        val command = if (word.startsWith("!") && commands.any { it.name == name }) {
            CommandRun("pending-$clientMessageId", name, CommandState.RUNNING, null, emptyList())
        } else {
            null
        }
        return Message(
            clientMessageId,
            chatId,
            Author.USER,
            text,
            sentAt,
            images = listOfNotNull(image?.let { MessageImage(null, it.mimeType, localUri = it.uri) }),
            sendState = state,
            failure = failure,
            command = command,
            clientMessageId = clientMessageId,
        )
    }

    private companion object {
        val WHITESPACE = Regex("\\s")
    }
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
    command = command?.toRun(),
    clientMessageId = clientMessageId,
)

internal fun CommandBody.toRun() = CommandRun(
    runId = runId,
    name = name,
    state = state,
    outcome = outcome,
    rows = rows.orEmpty().map { row -> CommandRow(row.title, row.status?.let { CommandStatus(it.label, it.tone) }, row.detail) },
)

/** Derived from the key, so it stays the same across starts. */
internal fun iconOf(conversationKey: String): ChatIcon =
    ChatIcon.entries[Math.floorMod(conversationKey.hashCode(), ChatIcon.entries.size)]
