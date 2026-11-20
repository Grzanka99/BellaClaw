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

/**
 * An image of a user's message; [mediaId] is null for one the server does not keep. A send from this
 * phone shows its picked file, [localUri], until history's row replaces it.
 */
data class MessageImage(
    val mediaId: String?,
    val mimeType: String,
    val localUri: String? = null,
)

/** An image picked on this phone that the server takes: its content [uri] and type. */
data class PickedImage(
    val uri: String,
    val mimeType: String,
)

/** Why a picked image is refused on the phone, before any upload. */
enum class ImageRefusal {
    TOO_LARGE,
    UNSUPPORTED_TYPE,
}

/** A picked image checked against the server's limits. */
sealed interface ImageCheck {
    data class Ready(val image: PickedImage) : ImageCheck

    data class Refused(val reason: ImageRefusal) : ImageCheck
}

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
