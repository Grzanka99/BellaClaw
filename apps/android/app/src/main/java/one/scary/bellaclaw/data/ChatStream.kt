package one.scary.bellaclaw.data

import java.time.Clock
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.StreamEventBody
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.Message

/**
 * The live stream of [ChatRepository]'s [state] and its events. A dropped stream reconnects after
 * [firstRetryMillis], doubling to [maxRetryMillis]. A `check` or `changed` has [sync] read the list, and
 * [sync]'s failed reads are tried again in the stream's scope. A `deleted` event has the phone [forget]
 * the conversation; a `reply` is dated by [clock].
 */
internal class ChatStream(
    private val api: ApiClient,
    private val state: MutableStateFlow<ChatState>,
    private val sync: ChatSync,
    private val scope: CoroutineScope,
    private val forget: suspend (conversationKey: String) -> Unit,
    private val clock: Clock,
    private val firstRetryMillis: Long,
    private val maxRetryMillis: Long,
) {
    /**
     * Keeps the stream open, reconnecting after a drop with a growing delay, until cancelled (background, a
     * session change). Failed reads are tried again in its scope, so they end with it.
     */
    suspend fun runStream() = coroutineScope {
        sync.live = this
        try {
            keepStreamOpen()
        } finally {
            sync.live = null
        }
    }

    private suspend fun keepStreamOpen() {
        var wait = firstRetryMillis
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
                wait = firstRetryMillis
            }
            delay(wait)
            wait = (wait * 2).coerceAtMost(maxRetryMillis)
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
                scope.launch { forget(key) }
            }
            "reply" -> if (key != null && event.text != null) {
                state.update { current ->
                    val chatId = current.conversation(key)?.chatId() ?: key
                    val reply = Message("reply-${UUID.randomUUID()}", chatId, Author.ASSISTANT, event.text, clock.instant())
                    current.copy(replies = current.replies + (key to current.replies[key].orEmpty() + reply))
                }
            }
        }
    }
}
