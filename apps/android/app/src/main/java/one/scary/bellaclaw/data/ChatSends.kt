package one.scary.bellaclaw.data

import java.time.Clock
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.scary.bellaclaw.data.local.ChatStore
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.EmptyBody
import one.scary.bellaclaw.data.remote.ModelBody
import one.scary.bellaclaw.data.remote.SendBody
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PickedImage
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.model.isNewChatId

/**
 * [ChatRepository]'s sends: shows each at once as pending in [state], creates a new chat with [sync] first,
 * uploads its image with [images] and posts it in [scope]. [modelOf] gives a plain chat's model by
 * conversation key; [chatStore] keeps it as the chat's pick.
 */
internal class ChatSends(
    private val api: ApiClient,
    private val state: MutableStateFlow<ChatState>,
    private val scope: CoroutineScope,
    private val sync: ChatSync,
    private val images: ChatImages,
    private val chatStore: ChatStore,
    private val clock: Clock,
    private val modelOf: (String) -> ModelChoice?,
) {
    /** One per conversation, shared by a new chat and its created key: its sends go out one at a time, in the order they were sent. */
    private val sendLocks = ConcurrentHashMap<String, Mutex>()

    /**
     * Shows [text] and [image] at once as pending and sends them with a fresh client message id, the image
     * uploaded first; a plain chat's send
     * names its model, which stays the chat's pick and becomes the model used last. Accepted, it shows as sent until history's row with that id replaces it. False,
     * and nothing sent, while the chat's conversation is not known, or a plain chat has no model.
     */
    fun send(chatId: String, text: String, image: PickedImage?): Boolean {
        val generation = state.value.generation
        val key = state.value.keyOf(chatId) ?: return false
        val model = if (chatId == BELLACLAW_CHAT_ID) {
            null
        } else {
            modelOf(key) ?: return false
        }
        val message = PendingSend(UUID.randomUUID().toString(), text, model, clock.instant(), image)
        state.update { current ->
            // A new chat created meanwhile holds its sends under its key.
            val queueKey = current.createdChats[key] ?: key
            current.copy(pending = current.pending + (queueKey to current.pending[queueKey].orEmpty() + message))
        }
        // A new chat's model is stored once the chat is created, under its conversation key.
        if (model != null && !isNewChatId(key)) {
            scope.launch { chatStore.setModel(key, model) }
        }
        scope.launch { post(generation, key, message) }
        return true
    }

    /** Sends the failed message [messageId] again, with the same client message id; an uploaded image is not uploaded again. */
    fun retry(chatId: String, messageId: String) {
        val generation = state.value.generation
        val key = state.value.keyOf(chatId) ?: return
        val message = state.value.pending[key]?.firstOrNull { it.clientMessageId == messageId && it.state == SendState.FAILED } ?: return
        changePending(key, messageId) { it.copy(state = SendState.PENDING, failure = null) }
        scope.launch { post(generation, key, message) }
    }

    /**
     * Creates the chat if [sendKey] is a new chat's id, uploads [message]'s image if it has not been, then
     * posts it; no request starts once the session of [generation] has ended. A conversation's sends wait for
     * the one before, so a text sent after a photo arrives after it.
     */
    private suspend fun post(generation: Int, sendKey: String, message: PendingSend) = sendLocks.getOrPut(sendKey) { Mutex() }.withLock {
        if (state.value.generation != generation) {
            return@withLock
        }
        val key = if (isNewChatId(sendKey)) {
            state.value.createdChats[sendKey] ?: createChat(generation, sendKey, message.model)
        } else {
            sendKey
        }
        if (key == null) {
            return@withLock markFailed(sendKey, message.clientMessageId, null)
        }
        var uploaded = message.uploaded
        if (message.image != null && uploaded == null) {
            when (val result = images.upload(key, message.image)) {
                is ApiResult.Success -> {
                    uploaded = result.value
                    changePending(key, message.clientMessageId) { it.copy(uploaded = result.value) }
                }
                is ApiResult.ApiError -> return@withLock markFailed(key, message.clientMessageId, result)
                ApiResult.NetworkFailure -> return@withLock markFailed(key, message.clientMessageId, null)
            }
        }
        if (state.value.generation != generation) {
            return@withLock
        }
        val model = message.model?.let { ModelBody(it.providerId, it.model, it.effort.wireName()) }
        val body = SendBody(message.clientMessageId, message.text, model, uploaded?.let { listOf(it) })
        when (val result = api.postSignedIn<SendBody, EmptyBody>(messagesPath(key), body)) {
            is ApiResult.Success -> changePending(key, message.clientMessageId) { it.copy(state = SendState.STORED) }
            is ApiResult.ApiError -> markFailed(key, message.clientMessageId, result)
            ApiResult.NetworkFailure -> markFailed(key, message.clientMessageId, null)
        }
    }

    /**
     * Creates the chat of [newChatId], moves its sends there and keeps [model], the first send's, as its pick;
     * null when the server could not.
     */
    private suspend fun createChat(generation: Int, newChatId: String, model: ModelChoice?): String? {
        val key = sync.createChat() ?: return null
        if (state.value.generation != generation) {
            return null
        }
        // The created chat's sends keep the new chat's lock, so they stay in order across the id change.
        sendLocks[key] = sendLocks.getValue(newChatId)
        state.update { current ->
            if (current.generation != generation) {
                current
            } else {
                val sends = current.pending[key].orEmpty() + current.pending[newChatId].orEmpty()
                current.copy(pending = current.pending - newChatId + (key to sends), createdChats = current.createdChats + (newChatId to key))
            }
        }
        model?.let { chatStore.setModel(key, it) }
        chatStore.forget(newChatId)
        return key
    }

    /** Marks the send failed, with the server's text for a refused request: `400`, and an upload's `413` or `415`. */
    private fun markFailed(key: String, clientMessageId: String, error: ApiResult.ApiError?) {
        changePending(key, clientMessageId) {
            it.copy(state = SendState.FAILED, failure = error?.message?.takeIf { error.status in SHOWN_REFUSALS })
        }
    }

    /** Changes the pending send [clientMessageId] if it is still there. */
    private fun changePending(key: String, clientMessageId: String, change: (PendingSend) -> PendingSend) {
        state.update { current ->
            val sends = current.pending[key] ?: return@update current
            current.copy(pending = current.pending + (key to sends.map { if (it.clientMessageId == clientMessageId) change(it) else it }))
        }
    }

    private companion object {
        val SHOWN_REFUSALS = setOf(400, 413, 415)
    }
}
