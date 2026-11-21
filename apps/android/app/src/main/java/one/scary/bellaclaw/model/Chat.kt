package one.scary.bellaclaw.model

import java.util.UUID

const val BELLACLAW_CHAT_ID = "bellaclaw"

private const val NEW_CHAT_PREFIX = "new:"

/** The id of a plain chat not created yet: its screen shows at once, and its first send creates the chat. */
fun newChatId(): String = NEW_CHAT_PREFIX + UUID.randomUUID()

fun isNewChatId(chatId: String): Boolean = chatId.startsWith(NEW_CHAT_PREFIX)

enum class ChatKind {
    BELLACLAW,
    PLAIN,
}

/** Icon of a plain chat. The UI maps each value to a Material icon. */
enum class ChatIcon {
    CODE,
    TRANSLATE,
    BAKERY,
    FILTER,
    ROCKET,
    LIGHTBULB,
    TERMINAL,
    FLIGHT,
    MUSIC,
    SCIENCE,
    PETS,
    CALCULATE,
}

/** A conversation: the one BellaClaw chat, or a plain chat. */
sealed interface Chat {
    val id: String
}

/** BellaClaw's chat; its models live in the settings. */
data object BellaClawChat : Chat {
    override val id = BELLACLAW_CHAT_ID
}

/**
 * A plain chat. [title] is null for a new chat; [model] is null while none is picked, none was used last
 * on this phone and the account's models are not loaded.
 */
data class PlainChat(
    override val id: String,
    val title: String?,
    val icon: ChatIcon,
    val model: ModelChoice?,
) : Chat
