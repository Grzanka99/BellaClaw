package one.scary.bellaclaw.model

import java.time.Instant

enum class Author {
    USER,
    ASSISTANT,
}

/** Where a message is: with the server (in its history, or a send it accepted), or sent from this phone and not accepted. */
enum class SendState {
    STORED,
    PENDING,
    FAILED,
}

/** An image of a user's message; [mediaId] is null for one the server does not keep. */
data class MessageImage(
    val mediaId: String?,
    val mimeType: String,
)

/**
 * A row of a conversation: a message or a display row (a command and its reply, a notice), drawn by its
 * [author]. A [SendState.FAILED] send has the server's [failure] text when it gave one.
 */
data class Message(
    val id: String,
    val chatId: String,
    val author: Author,
    val text: String,
    val sentAt: Instant,
    val images: List<MessageImage> = emptyList(),
    val sendState: SendState = SendState.STORED,
    val failure: String? = null,
)
