package one.scary.bellaclaw.data

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.ConversationBody
import one.scary.bellaclaw.data.remote.ConversationCreatedBody
import one.scary.bellaclaw.data.remote.ConversationsBody
import one.scary.bellaclaw.data.remote.EmptyBody
import one.scary.bellaclaw.data.remote.HistoryBody
import one.scary.bellaclaw.data.remote.HistoryRowBody
import one.scary.bellaclaw.model.isNewChatId

/**
 * Keeps [ChatRepository]'s [state] in step with the server: the conversation list, every loaded
 * history and the history of each open chat. Reads of the list run one at a time, and so do the syncs
 * of one history, so an older answer never lands after a newer one. A failed read of the list, or of an
 * open chat's history, is tried again after [firstRetryMillis], doubling to [maxRetryMillis], in [live]
 * until a read of it succeeds.
 */
internal class ChatSync(
    private val api: ApiClient,
    private val state: MutableStateFlow<ChatState>,
    private val scope: CoroutineScope,
    private val firstRetryMillis: Long,
    private val maxRetryMillis: Long,
) {
    private val listLock = Mutex()
    private val historyLocks = ConcurrentHashMap<String, Mutex>()
    private val loadingOlder = ConcurrentHashMap.newKeySet<String>()

    /** What the last read failed for: [LIST], or a conversation key. */
    private val failed = ConcurrentHashMap.newKeySet<String>()

    /** The retry loop of each of [failed], at most one each. */
    private val retries = ConcurrentHashMap<String, Job>()

    /** The scope of the session's stream while in the foreground, null otherwise: retries run in it and end with it. */
    @Volatile
    var live: CoroutineScope? = null

    /** Chat ids whose screen is open, once per open screen. */
    val openChats = MutableStateFlow(emptyList<String>())

    /** Reads the list; then brings every loaded history the list shows as changed, and every open chat's, up to date. */
    suspend fun refreshList() {
        val generation = state.value.generation
        val stale = listLock.withLock {
            val result = api.getSignedIn<ConversationsBody>("/api/conversations")
            if (result !is ApiResult.Success) {
                failed.add(LIST)
                retryLater(LIST) { refreshList() }
                return
            }
            failed.remove(LIST)
            val list = result.value.conversations
            val keys = list.mapTo(HashSet()) { it.conversationKey }
            var stale = emptyList<String>()
            state.update { current ->
                if (current.generation != generation) {
                    return@update current
                }
                // A chat missing from the list was deleted while the stream did not say so.
                val histories = current.histories.filterKeys { it in keys }
                val open = openChats.value
                stale = list.filter { conversation ->
                    val history = histories[conversation.conversationKey]
                    if (history == null) {
                        conversation.chatId() in open
                    } else {
                        history.revision < conversation.revision
                    }
                }.map { it.conversationKey }
                current.copy(
                    conversations = list,
                    isListLoaded = true,
                    histories = histories,
                    // A new chat's sends wait under its own id for the chat to be created.
                    pending = current.pending.filterKeys { it in keys || isNewChatId(it) },
                    replies = current.replies.filterKeys { it in keys },
                    typing = current.typing.filterTo(HashSet()) { it in keys },
                    steps = current.steps.filterKeys { it in keys },
                )
            }
            stale
        }
        stale.forEach { key -> scope.launch { syncHistory(key) } }
    }

    /**
     * Creates an empty plain chat and lists it below the Bella conversation, whether or not the list
     * was read; answers its key, or null when the server could not. Holds the list's lock, so no read
     * that started earlier drops the new chat.
     */
    suspend fun createChat(): String? {
        val generation = state.value.generation
        return listLock.withLock {
            val result = api.postSignedIn<EmptyBody, ConversationCreatedBody>("/api/conversations", EmptyBody)
            if (result !is ApiResult.Success) {
                return null
            }
            val key = result.value.conversationKey
            state.update { current ->
                // The server answers the account's empty chat when it has one, which the list may hold already.
                if (current.generation != generation || current.conversation(key) != null) {
                    current
                } else {
                    val list = current.conversations
                    val created = ConversationBody(key, ChatState.PLAIN, revision = 0, rewriteRevision = 0)
                    current.copy(conversations = list.take(1) + created + list.drop(1))
                }
            }
            key
        }
    }

    /**
     * Brings [key]'s history to the revision the list names: the rows after the newest one held, or the
     * newest page anew when nothing is held or a rewrite (a delete, a merge) happened since the held
     * revision. Repeats while a fetch moved the history on and it is still behind.
     */
    suspend fun syncHistory(key: String) {
        val generation = state.value.generation
        var synced = true
        historyLocks.getOrPut(key) { Mutex() }.withLock {
            var previous: Long? = null
            while (synced) {
                val current = state.value
                val listed = current.conversation(key)
                if (current.generation != generation || listed == null) {
                    break
                }
                val held = current.histories[key]
                if (held != null && (held.revision >= listed.revision || held.revision == previous)) {
                    break
                }
                previous = held?.revision
                synced = if (held == null || held.rows.isEmpty() || held.revision < listed.rewriteRevision) {
                    reload(generation, key)
                } else {
                    fetchAfter(generation, key, held)
                }
            }
        }
        if (synced) {
            failed.remove(key)
            return
        }
        val chatId = state.value.conversation(key)?.chatId()
        if (chatId in openChats.value) {
            failed.add(key)
            retryLater(key) { syncHistory(key) }
        }
    }

    /**
     * Calls [read] after a growing delay for as long as [id]'s last read failed, unless a loop for [id]
     * runs already; none outside [live].
     */
    private fun retryLater(id: String, read: suspend () -> Unit) {
        val live = live ?: return
        retries.compute(id) { _, running ->
            if (running?.isActive == true) {
                running
            } else {
                live.launch {
                    var wait = firstRetryMillis
                    while (true) {
                        delay(wait)
                        wait = (wait * 2).coerceAtMost(maxRetryMillis)
                        if (id !in failed) {
                            break
                        }
                        read()
                    }
                }
            }
        }
    }

    /** Replaces [key]'s history with its newest page; false when the read failed. */
    private suspend fun reload(generation: Int, key: String): Boolean {
        val page = api.getSignedIn<HistoryBody>(messagesPath(key))
        if (page !is ApiResult.Success) {
            return false
        }
        applyHistory(generation, key, replace = true) { History(page.value.messages, page.value.revision, page.value.nextBefore) }
        return true
    }

    /**
     * Adds the rows after [held]'s newest, page by page, and records the revision once the last page
     * arrived; reloads instead when a page shows a rewrite since [held]'s revision. False when a read failed.
     */
    private suspend fun fetchAfter(generation: Int, key: String, held: History): Boolean {
        val rows = mutableListOf<HistoryRowBody>()
        var revision = held.revision
        var after: Long? = held.rows.last().id
        while (after != null) {
            val page = api.getSignedIn<HistoryBody>("${messagesPath(key)}?after=$after")
            if (page !is ApiResult.Success) {
                return false
            }
            if (page.value.rewriteRevision > held.revision) {
                return reload(generation, key)
            }
            rows += page.value.messages
            revision = page.value.revision
            after = page.value.nextAfter
        }
        applyHistory(generation, key, replace = false) { history -> history.copy(rows = mergeRows(history.rows, rows), revision = revision) }
        return true
    }

    /** Loads the page of rows older than [key]'s oldest, if there is one and it is not loading already. */
    fun loadOlder(key: String) {
        val current = state.value
        val before = current.histories[key]?.nextBefore ?: return
        if (!loadingOlder.add(key)) {
            return
        }
        scope.launch {
            try {
                val page = api.getSignedIn<HistoryBody>("${messagesPath(key)}?before=$before")
                if (page is ApiResult.Success) {
                    applyHistory(current.generation, key, replace = false) { history ->
                        history.copy(rows = mergeRows(page.value.messages, history.rows), nextBefore = page.value.nextBefore)
                    }
                }
            } finally {
                loadingOlder.remove(key)
            }
        }
    }

    /**
     * Sets [key]'s history to [change] of the held one (an empty one for a [replace]) and drops the sends
     * it now has.
     */
    private fun applyHistory(generation: Int, key: String, replace: Boolean, change: (History) -> History) {
        state.update { current ->
            if (current.generation != generation) {
                return@update current
            }
            val held = current.histories[key]
            if (!replace && held == null) {
                return@update current
            }
            val history = change(held.takeUnless { replace } ?: History(emptyList(), 0, null))
            val stored = history.rows.mapNotNullTo(HashSet()) { it.clientMessageId }
            current.copy(
                histories = current.histories + (key to history),
                pending = current.pending + (key to current.pending[key].orEmpty().filter { it.clientMessageId !in stored }),
            )
        }
    }

    private companion object {
        /** The list's entry in [failed]; conversation keys always hold a colon. */
        const val LIST = "list"
    }
}

internal fun messagesPath(key: String) = "/api/conversations/$key/messages"

/** [older] then [newer], each row once. */
private fun mergeRows(older: List<HistoryRowBody>, newer: List<HistoryRowBody>): List<HistoryRowBody> {
    val ids = newer.mapTo(HashSet()) { it.id }
    return older.filter { it.id !in ids } + newer
}
