package one.scary.bellaclaw.ui.chat

import one.scary.bellaclaw.model.ActivityStep
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.ChatProvider
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ImageRefusal
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.TodoList
import java.time.LocalDate

data class ChatUiState(
    val kind: ChatKind = ChatKind.PLAIN,
    /** Null for BellaClaw and for a new plain chat. */
    val title: String? = null,
    /**
     * The conversation newest first, as the bottom-up list lays it out, with a day row above each day's
     * messages, and first the live activity card while a reply is in progress.
     */
    val rows: List<ChatRow> = emptyList(),
    val isStreamOpen: Boolean = false,
    val draft: String = "",
    val attachmentUri: String? = null,
    /** Why the last picked image was not attached, until another is picked, it is removed or a send goes. */
    val attachmentRefusal: ImageRefusal? = null,
    /** Whether a picked image is being checked; nothing can be sent meanwhile. */
    val isCheckingAttachment: Boolean = false,
    /** The image open full screen, or null. */
    val viewedImage: MessageImage? = null,
    /** The open model picker, or null when it is closed. Only plain chats have one. */
    val picker: ModelPickerState? = null,
    /** True when no chat has this screen's id; the screen then returns to Home. */
    val isMissing: Boolean = false,
    /** Whether the chat's conversation is known and, for a plain chat, its model; until then nothing can be sent. */
    val isReadyToSend: Boolean = false,
    /** The language last picked for dictation, as a BCP 47 tag; null means the phone's language. */
    val dictationLanguage: String? = null,
    /** The account's lists for BellaClaw's pill, the one it shows first. */
    val lists: List<TodoList> = emptyList(),
) {
    val canSend: Boolean
        get() = isReadyToSend && !isCheckingAttachment && (draft.isNotBlank() || attachmentUri != null)
}

/** One row of the conversation: a day label, a message or a reply's activity. */
sealed interface ChatRow {
    val key: String

    /** Keyed by [firstMessageId], the oldest message of its section, since one date can head two sections. */
    data class Day(val date: LocalDate, val firstMessageId: String) : ChatRow {
        override val key: String = "day-$firstMessageId"
    }

    data class Item(val message: Message) : ChatRow {
        override val key: String = "message-${message.id}"
    }

    /**
     * A reply's activity card: above a reply that took steps, which ran [seconds] from the first start to the
     * last end, or [isLive] below the newest row while the reply is in progress ([rows] empty before its
     * first step). The reply keeps its live card's [key], so the card stays one list item.
     */
    data class Activity(
        override val key: String,
        val rows: List<ActivityRow>,
        val seconds: Long = 0,
        val isLive: Boolean = false,
    ) : ChatRow
}

/** One row of a reply's activity. */
sealed interface ActivityRow {
    data class Step(val step: ActivityStep) : ActivityRow

    /** The pause before the next step, when it lasted a second or more. */
    data class Thought(val seconds: Long) : ActivityRow

    /** No step runs, and the reply is not there yet. */
    data object Thinking : ActivityRow
}

/**
 * The picker's providers usable now, of the last list read while it is read again, and its unsaved [selection],
 * one of their usable models at an effort it supports (null while the list is not loaded or none is
 * usable). Done stores it on the chat.
 */
data class ModelPickerState(
    val providers: Loadable<List<ChatProvider>>,
    val selection: ModelChoice?,
) {
    /** The efforts the selected model supports. */
    val efforts: List<Effort>
        get() {
            val provider = providers.valueOrNull.orEmpty().firstOrNull { it.id == selection?.providerId }
            return provider?.models?.firstOrNull { it.id == selection?.model }?.efforts.orEmpty()
        }
}
