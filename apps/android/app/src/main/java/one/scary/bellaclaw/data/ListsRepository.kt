package one.scary.bellaclaw.data

import java.time.Clock
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.scary.bellaclaw.data.local.ChatStore
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.ListChangesBody
import one.scary.bellaclaw.data.remote.ListOperationBody
import one.scary.bellaclaw.data.remote.ListsBody
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.ListChange
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.model.TodoItem
import one.scary.bellaclaw.model.TodoList

/**
 * The account's to-do lists from the gateway, held in memory for the current [session]. They are read
 * again whenever [refresh] is called: the live stream's `check` and `lists` events. A change from the app
 * shows at once on top of the lists read, and is sent in the application [scope], one request at a time
 * (reads too), so changes reach the server in order. A refused or failed change is dropped, sets [error], and the
 * lists are read again. A finished list swiped away is hidden through [chatStore] until its next change.
 * [now] ticks the time the lists are shown at, so ended lists leave on time.
 */
class ListsRepository(
    private val api: ApiClient,
    session: StateFlow<Session?>,
    private val chatStore: ChatStore,
    private val scope: CoroutineScope,
    private val clock: Clock = Clock.systemDefaultZone(),
    private val now: Flow<Instant> = minuteTicks(clock),
) {
    /** A change shown before the server answers it; its [at] is the list's last change meanwhile. */
    private data class Pending(val id: Long, val change: ListChange, val at: Instant)

    /** [server]: the lists last read, null before the first read; [pending]: changes not answered yet, in order. */
    private data class State(
        val generation: Int = 0,
        val server: List<TodoList>? = null,
        val pending: List<Pending> = emptyList(),
        val error: AccountError? = null,
    )

    private val state = MutableStateFlow(State())
    private val requests = Mutex()
    private val nextPendingId = AtomicLong()

    init {
        scope.launch {
            session.map { it?.token }.distinctUntilChanged().collect {
                state.update { State(generation = it.generation + 1) }
            }
        }
    }

    /**
     * The lists to show, null before the first read: not ended, not swiped away, and a finished list without an end
     * for an hour after its last change. By end, the nearest first, then the oldest first; a finished list keeps its place.
     */
    val lists: Flow<List<TodoList>?> = combine(
        state.map { current -> current.server?.let { server -> current.pending.fold(server) { lists, pending -> lists.applying(pending) } } }
            .distinctUntilChanged(),
        chatStore.chats.map { it.dismissedLists }.distinctUntilChanged(),
        now,
    ) { lists, dismissed, now ->
        lists?.filter { list ->
            val disappearsAt = list.disappearsAt
            val swipedAway = dismissed[list.id]?.let { it >= list.updatedAt.toEpochMilli() } == true
            (disappearsAt == null || disappearsAt > now) && !swipedAway
        }?.sortedBy { it.endsAt ?: Instant.MAX }
    }.distinctUntilChanged()

    /** Why the last change was not made, until the next change or [clearError]. */
    val error: Flow<AccountError?> = state.map { it.error }.distinctUntilChanged()

    fun clearError() {
        state.update { it.copy(error = null) }
    }

    /** Reads the lists again. */
    fun refresh() {
        scope.launch { requests.withLock { read() } }
    }

    /** Shows [change] at once and sends it. */
    fun change(change: ListChange) {
        val pending = Pending(nextPendingId.incrementAndGet(), change, clock.instant())
        val generation = state.value.generation
        state.update { it.copy(pending = it.pending + pending, error = null) }
        scope.launch {
            requests.withLock {
                val result = api.postSignedIn<ListChangesBody, ListsBody>("/api/lists/changes", ListChangesBody(listOf(change.body())))
                state.update { current ->
                    if (current.generation != generation) {
                        return@update current
                    }
                    val rest = current.pending - pending
                    when (result) {
                        is ApiResult.Success -> current.copy(server = result.value.lists(), pending = rest)
                        is ApiResult.ApiError -> current.copy(pending = rest, error = AccountError.Server(result.status, result.message))
                        ApiResult.NetworkFailure -> current.copy(pending = rest, error = AccountError.Network)
                    }
                }
                if (result !is ApiResult.Success) {
                    read()
                }
            }
        }
    }

    /** Hides the finished list [list] until it changes again. */
    fun dismiss(list: TodoList) {
        scope.launch { chatStore.dismissList(list.id, list.updatedAt.toEpochMilli()) }
    }

    private suspend fun read() {
        val generation = state.value.generation
        val result = api.getSignedIn<ListsBody>("/api/lists")
        if (result is ApiResult.Success) {
            state.update { if (it.generation == generation) it.copy(server = result.value.lists()) else it }
        }
    }

    /** These lists with [pending] made, the changed list's last change at the pending's time. */
    private fun List<TodoList>.applying(pending: Pending): List<TodoList> {
        val change = pending.change
        if (change is ListChange.DeleteList) {
            return filter { it.id != change.listId }
        }
        return map { list ->
            val items = list.items
            val changed = when (change) {
                is ListChange.SetDone -> list.copy(items = items.map { if (it.id == change.itemId) it.copy(done = change.done) else it })
                is ListChange.EditItem -> list.copy(items = items.map { if (it.id == change.itemId) it.copy(text = change.text) else it })
                is ListChange.DeleteItem -> list.copy(items = items.filter { it.id != change.itemId })
                is ListChange.MoveItem -> {
                    val item = items.firstOrNull { it.id == change.itemId }
                    if (item == null) list else {
                        val rest = items - item
                        list.copy(items = rest.toMutableList().apply { add(change.toIndex.coerceIn(0, rest.size), item) })
                    }
                }
                is ListChange.AddItem -> if (list.id == change.listId) {
                    list.copy(items = items + TodoItem("pending-${pending.id}", change.text, done = false))
                } else {
                    list
                }
                is ListChange.RenameList -> if (list.id == change.listId) list.copy(name = change.name) else list
                is ListChange.DeleteList -> list
            }
            if (changed == list) list else changed.copy(updatedAt = pending.at)
        }
    }

    private fun ListChange.body(): ListOperationBody = when (this) {
        is ListChange.SetDone -> ListOperationBody("update_item", itemId = itemId, done = done)
        is ListChange.EditItem -> ListOperationBody("update_item", itemId = itemId, text = text)
        is ListChange.AddItem -> ListOperationBody("add_items", listId = listId, items = listOf(text))
        is ListChange.MoveItem -> ListOperationBody("move_item", itemId = itemId, toIndex = toIndex)
        is ListChange.DeleteItem -> ListOperationBody("delete_item", itemId = itemId)
        is ListChange.RenameList -> ListOperationBody("rename_list", listId = listId, name = name)
        is ListChange.DeleteList -> ListOperationBody("delete_list", listId = listId)
    }

    private fun ListsBody.lists() = lists.map { list ->
        TodoList(
            list.id,
            list.name,
            list.expiresAt?.let(Instant::ofEpochMilli),
            Instant.ofEpochMilli(list.updatedAt),
            list.items.map { TodoItem(it.id, it.text, it.done) },
        )
    }

    private companion object {
        /** The time now, then at the start of every minute. */
        fun minuteTicks(clock: Clock): Flow<Instant> = flow {
            while (true) {
                val now = clock.instant()
                emit(now)
                delay(MINUTE_MILLIS - now.toEpochMilli() % MINUTE_MILLIS)
            }
        }

        const val MINUTE_MILLIS = 60_000L
    }
}
