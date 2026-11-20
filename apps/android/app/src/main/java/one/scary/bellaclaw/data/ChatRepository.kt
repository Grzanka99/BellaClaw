package one.scary.bellaclaw.data

import java.io.File
import java.time.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.local.ChatStore
import one.scary.bellaclaw.data.local.ImageCache
import one.scary.bellaclaw.data.local.PickedImages
import one.scary.bellaclaw.data.local.LocalChats
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ConversationBody
import one.scary.bellaclaw.model.AppPush
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.BellaClawChat
import one.scary.bellaclaw.model.Chat
import one.scary.bellaclaw.model.ChatNotification
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ImageCheck
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.PickedImage
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.model.SettingsSnapshot
import one.scary.bellaclaw.model.isNewChatId

/**
 * The account's conversations from the gateway: the list, history, sends and the live stream, held in
 * memory for the current [session] and dropped when it changes. The stream is open while signed in and
 * [foreground]. [chatStore] keeps each plain chat's model, the model used last and what was last seen; a
 * chat with no picked model uses the model used last, else the [settings]' provider and Main model, and
 * has none while neither is known. [scope] lives as long as the application; network
 * work runs in it, so leaving a screen does not stop a send. A dropped stream and a failed read are
 * tried again after [retryMillis], doubling to 30 s. A send's image is read with [pickedImages];
 * history's images are kept in [imageCache] for the signed-in account only.
 */
class ChatRepository(
    private val api: ApiClient,
    session: StateFlow<Session?>,
    foreground: Flow<Boolean>,
    private val settings: StateFlow<SettingsSnapshot>,
    private val chatStore: ChatStore,
    pickedImages: PickedImages,
    imageCache: ImageCache,
    private val scope: CoroutineScope,
    private val clock: Clock = Clock.systemDefaultZone(),
    private val retryMillis: Long = FIRST_RETRY_MILLIS,
) {
    private val state = MutableStateFlow(ChatState())
    private val sync = ChatSync(api, state, scope, retryMillis, MAX_RETRY_MILLIS)
    private val stream = ChatStream(api, state, sync, scope, chatStore::forget, clock, retryMillis, MAX_RETRY_MILLIS)
    private val images = ChatImages(api, session, pickedImages, imageCache)
    private val sends = ChatSends(api, state, scope, sync, images, chatStore, clock) { key ->
        modelOf(key, chatStore.chats.value, settings.value)
    }

    init {
        scope.launch {
            session.collectLatest { current ->
                state.update { ChatState(generation = it.generation + 1) }
                images.onSession(current)
                if (current != null) {
                    foreground.collectLatest { isForeground ->
                        if (isForeground) {
                            stream.runStream()
                        }
                    }
                }
            }
        }
    }

    /** BellaClaw's chat, always there, then the plain chats, the latest active first. */
    val chats: Flow<List<Chat>> =
        combine(state.map { it.conversations }.distinctUntilChanged(), chatStore.chats, settings) { list, local, settings ->
            listOf(BellaClawChat) + plainChats(list, local, settings)
        }

    /**
     * The newest row of each chat that has one, by chat id: the list's, else the newest this phone holds
     * (a send in progress), so a chat whose first message is on its way already has one.
     */
    val latestMessages: Flow<Map<String, Message>> = state.map { current ->
        current.conversations.mapNotNull { conversation ->
            val chatId = conversation.chatId()
            val latest = conversation.lastMessage?.toMessage(chatId) ?: current.messagesOf(chatId).lastOrNull()
            latest?.let { chatId to it }
        }.toMap()
    }.distinctUntilChanged()

    /** Chat ids whose newest row is newer than the newest one seen with the chat's screen open. */
    val unread: Flow<Set<String>> = combine(state.map { it.conversations }.distinctUntilChanged(), chatStore.chats) { list, local ->
        list.filter { conversation ->
            val newest = conversation.lastMessage?.id ?: return@filter false
            newest > (local.lastSeen[conversation.conversationKey] ?: -1)
        }.mapTo(HashSet()) { it.chatId() }
    }.distinctUntilChanged()

    /** The conversation keys of the chats whose screen is open. */
    val openConversations: Flow<Set<String>> = combine(sync.openChats, state) { open, current ->
        open.mapNotNullTo(HashSet()) { current.keyOf(it) }
    }.distinctUntilChanged()

    /** Whether the live stream to the server is open. */
    val isStreamOpen: Flow<Boolean> = state.map { it.isStreamOpen }.distinctUntilChanged()

    /**
     * The chat once it is known; null when the list has no [chatId]: the chat was deleted. A new chat is an
     * untitled plain chat until its first send creates it, then the created chat, under its own id.
     */
    fun chat(chatId: String): Flow<Chat?> {
        if (chatId == BELLACLAW_CHAT_ID) {
            return flowOf(BellaClawChat)
        }
        if (isNewChatId(chatId)) {
            return combine(state, chatStore.chats, settings) { current, local, settings ->
                val key = current.createdChats[chatId] ?: return@combine PlainChat(chatId, null, iconOf(chatId), modelOf(chatId, local, settings))
                plainChats(current.conversations, local, settings).firstOrNull { it.id == key }
            }.distinctUntilChanged()
        }
        // The list and whether it loaded come from one snapshot, so a loaded list never shows without its chats.
        val list = state.map { it.conversations to it.isListLoaded }.distinctUntilChanged()
        return combine(list, chatStore.chats, settings) { (conversations, loaded), local, settings ->
            plainChats(conversations, local, settings).firstOrNull { it.id == chatId } to loaded
        }.filter { (chat, loaded) -> chat != null || loaded }.map { it.first }.distinctUntilChanged()
    }

    /** Whether [chatId]'s conversation is known and, for a plain chat, its model, so a message can be sent to it. */
    fun canSend(chatId: String): Flow<Boolean> = combine(state, chatStore.chats, settings) { current, local, settings ->
        val key = current.keyOf(chatId) ?: return@combine false
        chatId == BELLACLAW_CHAT_ID || modelOf(key, local, settings) != null
    }.distinctUntilChanged()

    /**
     * The chat's rows, oldest first. Collecting it means the chat's screen is open: its history is brought
     * up to date (now, or with the next list read while the chat is not known or a read failed), and its
     * newest stored row counts as seen.
     */
    fun messages(chatId: String): Flow<List<Message>> = channelFlow {
        sync.openChats.update { it + chatId }
        try {
            // Not known yet: the list read fetches it.
            state.value.keyOf(chatId)?.let { key -> launch { sync.syncHistory(key) } }
            state.map { it.messagesOf(chatId) }.distinctUntilChanged().collect { messages ->
                send(messages)
                val key = state.value.keyOf(chatId)
                val newest = key?.let { state.value.histories[it]?.rows?.lastOrNull()?.id }
                if (key != null && newest != null) {
                    chatStore.markSeen(key, newest)
                }
            }
        } finally {
            sync.openChats.update { it - chatId }
        }
    }

    fun isTyping(chatId: String): Flow<Boolean> =
        state.map { current -> current.keyOf(chatId)?.let { it in current.typing } == true }.distinctUntilChanged()

    /** Loads the page of rows older than the chat's oldest, if there is one and it is not loading already. */
    fun loadOlder(chatId: String) {
        state.value.keyOf(chatId)?.let(sync::loadOlder)
    }

    /** The image at [uri] ready to send, or why the server would refuse it. */
    suspend fun checkImage(uri: String): ImageCheck = images.check(uri)

    /** The image [mediaId] of [chatId] as a file on the phone; null when the server no longer keeps it or it cannot be fetched now. */
    suspend fun imageFile(chatId: String, mediaId: String): File? {
        val key = state.value.keyOf(chatId) ?: return null
        return images.file(key, mediaId)
    }

    /** Shows [text] and [image] at once as pending and sends them; see [ChatSends.send]. */
    fun send(chatId: String, text: String, image: PickedImage?): Boolean = sends.send(chatId, text, image)

    /** Sends the failed message [messageId] again; see [ChatSends.retry]. */
    fun retry(chatId: String, messageId: String) = sends.retry(chatId, messageId)

    /** Brings [conversationKey] up to date after a push, as on a `changed`: reads the list, then syncs its history. */
    suspend fun catchUp(conversationKey: String) {
        sync.refreshList()
        sync.syncHistory(conversationKey)
    }

    /**
     * What [push]'s notification shows: its chat from the push's kind, a plain chat's title once the list
     * names it, and its row's text from history once fetched, else the push's.
     */
    fun notificationOf(push: AppPush): ChatNotification {
        val current = state.value
        val key = push.conversationKey
        val text = current.histories[key]?.rows?.firstOrNull { it.id == push.messageId }?.text ?: push.text
        if (push.kind == ChatState.BELLA) {
            return ChatNotification(key, BELLACLAW_CHAT_ID, null, text)
        }
        val title = current.conversation(key)?.title
        return ChatNotification(key, key, title, text)
    }

    suspend fun setModel(chatId: String, model: ModelChoice) {
        chatStore.setModel(chatId, model)
    }

    /** Forgets the model picked in the new chat [newChatId], closed without a send. */
    fun forgetNewChat(newChatId: String) {
        scope.launch { chatStore.forget(newChatId) }
    }

    /** The plain chats of [list], in its order. */
    private fun plainChats(list: List<ConversationBody>, local: LocalChats, settings: SettingsSnapshot): List<PlainChat> =
        list.filter { it.kind != ChatState.BELLA }.map { conversation ->
            val key = conversation.conversationKey
            PlainChat(key, conversation.title, iconOf(key), modelOf(key, local, settings))
        }

    /**
     * The model picked for [key], else the model used last unless the loaded list refuses it, else the account's provider and Main model at
     * Main's effort; for the model's default effort, MEDIUM if the model lists it, else its first. Null
     * while none of them is known.
     */
    private fun modelOf(key: String, local: LocalChats, settings: SettingsSnapshot): ModelChoice? {
        local.models[key]?.let { return it }
        val catalog = settings.chatModels.valueOrNull
        local.lastModel?.takeIf { last ->
            catalog == null || catalog.any { provider ->
                provider.isUsable && provider.id == last.providerId &&
                    provider.models.any { it.id == last.model && last.effort in it.efforts }
            }
        }?.let { return it }
        val models = settings.models.valueOrNull ?: return null
        val main = models.roles[ModelRole.MAIN] ?: return null
        val efforts = models.models.firstOrNull { it.id == main.model }?.efforts.orEmpty()
        val effort = main.effort ?: Effort.MEDIUM.takeIf { it in efforts } ?: efforts.firstOrNull() ?: return null
        return ModelChoice(models.providerId, main.model, effort)
    }

    private companion object {
        const val FIRST_RETRY_MILLIS = 1_000L
        const val MAX_RETRY_MILLIS = 30_000L
    }
}
