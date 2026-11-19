package one.scary.bellaclaw.ui.chat

import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.Provider
import java.time.LocalDate

data class ChatUiState(
    val kind: ChatKind = ChatKind.PLAIN,
    /** Null for BellaClaw and for a new plain chat. */
    val title: String? = null,
    /** The conversation newest first, as the bottom-up list lays it out, with a day row above each day's messages. */
    val rows: List<ChatRow> = emptyList(),
    val isTyping: Boolean = false,
    val isStreamOpen: Boolean = false,
    val draft: String = "",
    val attachmentUri: String? = null,
    /** The open model picker, or null when it is closed. Only plain chats have one. */
    val picker: ModelPickerState? = null,
    /** True when no chat has this screen's id; the screen then returns to Home. */
    val isMissing: Boolean = false,
) {
    val canSend: Boolean
        get() = draft.isNotBlank() || attachmentUri != null
}

/** One row of the conversation: a day label or a message. */
sealed interface ChatRow {
    val key: String

    /** Keyed by [firstMessageId], the oldest message of its section, since one date can head two sections. */
    data class Day(val date: LocalDate, val firstMessageId: String) : ChatRow {
        override val key: String = "day-$firstMessageId"
    }

    data class Item(val message: Message) : ChatRow {
        override val key: String = "message-${message.id}"
    }
}

/** The picker's unsaved selection of one of [providers]; Done stores it on the chat. */
data class ModelPickerState(
    val providers: List<Provider>,
    val provider: Provider,
    val selection: ModelChoice,
) {
    val models: List<String>
        get() = provider.models

    val effort: Effort
        get() = selection.effort
}
