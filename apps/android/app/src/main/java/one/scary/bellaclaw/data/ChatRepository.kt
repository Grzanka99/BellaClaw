package one.scary.bellaclaw.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.sample.SampleChats
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.Chat
import one.scary.bellaclaw.model.ChatIcon
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PlainChat
import java.time.Clock
import java.util.UUID
import kotlin.random.Random

/**
 * Single source of truth for chats and their messages, held in memory from [SampleChats].
 * [scope] lives as long as the application; work that must outlive a screen runs in it.
 */
class ChatRepository(
    private val scope: CoroutineScope,
    private val clock: Clock = Clock.systemDefaultZone(),
    private val random: Random = Random.Default,
) {
    private val chatsState = MutableStateFlow(SampleChats.chats)
    private val messagesState = MutableStateFlow(SampleChats.messages(clock.instant()).groupBy { it.chatId })
    private val typingState = MutableStateFlow<Set<String>>(emptySet())

    /** The current sample typing timer of each chat; a timer removes its own entry when it ends typing. */
    private val typingTimers = mutableMapOf<String, Job>()

    val chats: Flow<List<Chat>> = chatsState

    /** The newest message of each chat that has one, by chat id. */
    val latestMessages: Flow<Map<String, Message>> = messagesState.map { byChat ->
        byChat.mapValues { (_, messages) -> messages.last() }
    }

    /** Whether the live stream to the server is open. Always open while the data is sample data. */
    val isStreamOpen: Flow<Boolean> = flowOf(true)

    /** The chat, or null when no chat has [chatId] (e.g. a restored screen of a chat this process never had). */
    fun chat(chatId: String): Flow<Chat?> = chatsState.map { chats -> chats.firstOrNull { it.id == chatId } }.distinctUntilChanged()

    fun messages(chatId: String): Flow<List<Message>> =
        messagesState.map { it[chatId].orEmpty() }.distinctUntilChanged()

    fun isTyping(chatId: String): Flow<Boolean> = typingState.map { chatId in it }.distinctUntilChanged()

    /**
     * Appends the user's message and shows the assistant typing until [SAMPLE_TYPING_MILLIS] after the
     * chat's latest send. The timer runs in [scope], so leaving the chat does not stop it.
     */
    suspend fun send(chatId: String, text: String, imageUri: String?) {
        val message = Message(UUID.randomUUID().toString(), chatId, Author.USER, text, imageUri, clock.instant())
        messagesState.update { byChat -> byChat + (chatId to byChat[chatId].orEmpty() + message) }
        synchronized(typingTimers) {
            typingTimers[chatId]?.cancel()
            typingState.update { it + chatId }
            typingTimers[chatId] = scope.launch {
                delay(SAMPLE_TYPING_MILLIS)
                // Only the chat's current timer ends typing; one replaced after its delay does nothing.
                // Typing and the map entry are set under this lock before the check can run.
                synchronized(typingTimers) {
                    if (typingTimers[chatId] === coroutineContext.job) {
                        typingTimers.remove(chatId)
                        typingState.update { it - chatId }
                    }
                }
            }
        }
    }

    /** Creates an untitled plain chat with a random icon and returns its id. */
    suspend fun createChat(): String {
        val icons = ChatIcon.entries
        val chat = PlainChat(
            id = UUID.randomUUID().toString(),
            title = null,
            icon = icons[random.nextInt(icons.size)],
            model = SampleChats.defaultModel,
        )
        chatsState.update { it + chat }
        return chat.id
    }

    suspend fun setModel(chatId: String, model: ModelChoice) {
        chatsState.update { chats -> chats.map { if (it is PlainChat && it.id == chatId) it.copy(model = model) else it } }
    }

    companion object {
        const val SAMPLE_TYPING_MILLIS = 2_000L
    }
}
