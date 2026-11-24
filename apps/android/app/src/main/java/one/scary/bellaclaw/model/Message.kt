package one.scary.bellaclaw.model

import java.time.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
 * One thing the assistant did for a reply (a tool call), as the server labels it; [tool] is the tool's
 * name. [durationMs] is null while it runs.
 */
data class ActivityStep(
    val tool: String,
    val label: String,
    val detail: String,
    val startedAt: Instant,
    val durationMs: Long?,
    val failed: Boolean = false,
)

/** Where a command's run is; the server names each in lower case. */
@Serializable
enum class CommandState {
    @SerialName("running") RUNNING,
    @SerialName("done") DONE,
    @SerialName("failed") FAILED,
}

/** The colour of a command row's status label; the server names each in lower case. */
@Serializable
enum class CommandTone {
    @SerialName("neutral") NEUTRAL,
    @SerialName("good") GOOD,
    @SerialName("warning") WARNING,
    @SerialName("bad") BAD,
}

/** A command row's status: its [label], coloured by its [tone]. */
data class CommandStatus(val label: String, val tone: CommandTone)

/** One item a command lists: its [title], a [status], and a [detail] line. */
data class CommandRow(
    val title: String,
    val status: CommandStatus?,
    val detail: String?,
)

/**
 * One run of the catalog command [name] (without "!"), on each row of the run: its [state] and short
 * [outcome] as of that row, and the [rows] it listed.
 */
data class CommandRun(
    val runId: String,
    val name: String,
    val state: CommandState,
    val outcome: String?,
    val rows: List<CommandRow>,
)

/**
 * A row of a conversation: a message or a display row (a command and its reply, a notice), drawn by its
 * [author]. A [SendState.FAILED] send has the server's [failure] text when it gave one.
 * An assistant reply has the [steps] that led to it, by start; a [scheduled] one is a delivery of a
 * scheduled job. A [finishedList] row is the card of a list the first time it finished. A row of a
 * command's run has its [command]; a send from the app, and a confidential reply to one, its [clientMessageId].
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
    val steps: List<ActivityStep> = emptyList(),
    val scheduled: Boolean = false,
    val finishedList: FinishedList? = null,
    val command: CommandRun? = null,
    val clientMessageId: String? = null,
)
