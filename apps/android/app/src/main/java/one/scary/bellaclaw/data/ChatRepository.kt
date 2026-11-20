package one.scary.bellaclaw.data

import java.time.Clock
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
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
import one.scary.bellaclaw.data.local.LocalChats
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.ConversationBody
import one.scary.bellaclaw.data.remote.EmptyBody
import one.scary.bellaclaw.data.remote.ModelBody
import one.scary.bellaclaw.data.remote.SendBody
import one.scary.bellaclaw.data.remote.StreamEventBody
import one.scary.bellaclaw.model.AppPush
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.BellaClawChat
import one.scary.bellaclaw.model.Chat
import one.scary.bellaclaw.model.ChatNotification
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.model.SettingsSnapshot

/**
 * The account's conversations from the gateway: the list, history, sends and the live stream, held in
 * memory for the current [session] and dropped when it changes. The stream is open while signed in and
 * [foreground]. [chatStore] keeps each plain chat's model, the model used last and what was last seen; a
 * chat with no picked model uses the model used last, else the [settings]' provider and Main model, and
 * has none while neither is known. [scope] lives as long as the application; network
 * work runs in it, so leaving a screen does not stop a send. A dropped stream and a failed read are
 * tried again after [retryMillis], doubling to 30 s.
 */
class ChatRepository(
    private val api: ApiClient,
    session: StateFlow<Session?>,
    foreground: Flow<Boolean>,
    private val settings: StateFlow<SettingsSnapshot>,
    private val chatStore: ChatStore,
    private val scope: CoroutineScope,
    private val clock: Clock = Clock.systemDefaultZone(),
    private val retryMillis: Long = FIRST_RETRY_MILLIS,
) {
    private val state = MutableStateFlow(ChatState())
    private val sync = ChatSync(api, state, scope, retryMillis, MAX_RETRY_MILLIS)

    init {
        scope.launch {
            session.collectLatest { current ->
                state.update { ChatState(generation = it.generation + 1) }
                if (current != null) {
                    foreground.collectLatest { isForeground ->
                        if (isForeground) {
                            runStream()
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

    /** The newest row of each chat that has one, by chat id. */
    val latestMessages: Flow<Map<String, Message>> = state.map { current ->
        current.conversations.mapNotNull { conversation ->
            val chatId = conversation.chatId()
            conversation.lastMessage?.let { chatId to it.toMessage(chatId) }
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

    /** The chat once it is known; null when the list has no [chatId]: the chat was deleted. */
    fun chat(chatId: String): Flow<Chat?> {
        if (chatId == BELLACLAW_CHAT_ID) {
            return flowOf(BellaClawChat)
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

    /**
     * Shows [text] at once as pending and sends it with a fresh client message id; a plain chat's send
     * names its model, which stays the chat's pick and becomes the model used last. Accepted, it shows as sent until history's row with that id replaces it. False,
     * and nothing sent, while the chat's conversation is not known, or a plain chat has no model.
     */
    fun send(chatId: String, text: String): Boolean {
        val key = state.value.keyOf(chatId) ?: return false
        val model = if (chatId == BELLACLAW_CHAT_ID) {
            null
        } else {
            modelOf(key, chatStore.chats.value, settings.value) ?: return false
        }
        val message = PendingSend(UUID.randomUUID().toString(), text, model, clock.instant())
        state.update { it.copy(pending = it.pending + (key to it.pending[key].orEmpty() + message)) }
        if (model != null) {
            scope.launch { chatStore.setModel(key, model) }
        }
        scope.launch { post(key, message) }
        return true
    }

    /** Sends the failed message [messageId] again, with the same client message id. */
    fun retry(chatId: String, messageId: String) {
        val key = state.value.keyOf(chatId) ?: return
        val message = state.value.pending[key]?.firstOrNull { it.clientMessageId == messageId && it.state == SendState.FAILED } ?: return
        changePending(key, messageId) { it.copy(state = SendState.PENDING, failure = null) }
        scope.launch { post(key, message) }
    }

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
        val title = current.conversations.firstOrNull { it.conversationKey == key }?.title
        return ChatNotification(key, key, title, text)
    }

    /** Creates an empty plain chat and returns its id, or null when the server could not. */
    suspend fun createChat(): String? = sync.createChat()

    suspend fun setModel(chatId: String, model: ModelChoice) {
        chatStore.setModel(chatId, model)
    }

    private suspend fun post(key: String, message: PendingSend) {
        val body = SendBody(message.clientMessageId, message.text, message.model?.let { ModelBody(it.providerId, it.model, it.effort.name.lowercase()) })
        when (val result = api.postSignedIn<SendBody, EmptyBody>(messagesPath(key), body)) {
            is ApiResult.Success -> changePending(key, message.clientMessageId) { it.copy(state = SendState.STORED) }
            is ApiResult.ApiError -> changePending(key, message.clientMessageId) {
                it.copy(state = SendState.FAILED, failure = result.message.takeIf { result.status == BAD_REQUEST })
            }
            ApiResult.NetworkFailure -> changePending(key, message.clientMessageId) { it.copy(state = SendState.FAILED) }
        }
    }

    /** Changes the pending send [clientMessageId] if it is still there. */
    private fun changePending(key: String, clientMessageId: String, change: (PendingSend) -> PendingSend) {
        state.update { current ->
            val sends = current.pending[key] ?: return@update current
            current.copy(pending = current.pending + (key to sends.map { if (it.clientMessageId == clientMessageId) change(it) else it }))
        }
    }

    /**
     * Keeps the stream open, reconnecting after a drop with a growing delay, until cancelled (background, a
     * session change). Failed reads are tried again in its scope, so they end with it.
     */
    private suspend fun runStream() = coroutineScope {
        sync.live = this
        try {
            keepStreamOpen()
        } finally {
            sync.live = null
        }
    }

    private suspend fun keepStreamOpen() {
        var wait = retryMillis
        while (true) {
            var opened = false
            val result = try {
                api.streamSignedIn("/api/stream") { type, data ->
                    opened = true
                    val event = try {
                        ApiClient.json.decodeFromString<StreamEventBody>(data)
                    } catch (_: IllegalArgumentException) {
                        // SerializationException included: an event this app cannot read is skipped.
                        null
                    }
                    if (event != null) {
                        onEvent(type, event)
                    }
                }
            } finally {
                state.update { it.copy(isStreamOpen = false, typing = emptySet()) }
            }
            if (result is ApiResult.ApiError && result.status == ApiClient.UNAUTHORIZED) {
                return
            }
            if (opened) {
                wait = retryMillis
            }
            delay(wait)
            wait = (wait * 2).coerceAtMost(MAX_RETRY_MILLIS)
        }
    }

    private fun onEvent(type: String, event: StreamEventBody) {
        val key = event.conversationKey
        when (type) {
            "check" -> {
                state.update { it.copy(isStreamOpen = true, typing = emptySet()) }
                scope.launch { sync.refreshList() }
            }
            "changed" -> scope.launch { sync.refreshList() }
            "typing" -> if (key != null) {
                state.update { if (event.typing) it.copy(typing = it.typing + key) else it.copy(typing = it.typing - key) }
            }
            "deleted" -> if (key != null) {
                state.update { it.withoutConversation(key) }
                scope.launch { chatStore.forget(key) }
            }
            "reply" -> if (key != null && event.text != null) {
                state.update { current ->
                    val chatId = current.conversations?.firstOrNull { it.conversationKey == key }?.chatId() ?: key
                    val reply = Message("reply-${UUID.randomUUID()}", chatId, Author.ASSISTANT, event.text, clock.instant())
                    current.copy(replies = current.replies + (key to current.replies[key].orEmpty() + reply))
                }
            }
        }
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
        val catalog = (settings.chatModels as? Loadable.Loaded)?.value
        local.lastModel?.takeIf { last ->
            catalog == null || catalog.any { provider ->
                provider.isUsable && provider.id == last.providerId &&
                    provider.models.any { it.id == last.model && last.effort in it.efforts }
            }
        }?.let { return it }
        val models = (settings.models as? Loadable.Loaded)?.value ?: return null
        val main = models.roles[ModelRole.MAIN] ?: return null
        val efforts = models.models.firstOrNull { it.id == main.model }?.efforts.orEmpty()
        val effort = main.effort ?: Effort.MEDIUM.takeIf { it in efforts } ?: efforts.firstOrNull() ?: return null
        return ModelChoice(models.providerId, main.model, effort)
    }

    private companion object {
        const val BAD_REQUEST = 400
        const val FIRST_RETRY_MILLIS = 1_000L
        const val MAX_RETRY_MILLIS = 30_000L
    }
}
