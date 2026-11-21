package one.scary.bellaclaw.model

import java.time.Duration
import java.time.Instant

/** An item of a [TodoList]. */
data class TodoItem(val id: String, val text: String, val done: Boolean)

/**
 * A to-do list of the account, its items in order. [endsAt] is when it ends, null for never; [updatedAt]
 * is its last change, an item's included.
 */
data class TodoList(
    val id: String,
    val name: String,
    val endsAt: Instant?,
    val updatedAt: Instant,
    val items: List<TodoItem>,
) {
    val doneCount: Int
        get() = items.count { it.done }

    /** Every item is ticked, and there is at least one. */
    val isFinished: Boolean
        get() = items.isNotEmpty() && items.all { it.done }

    /** When the app stops showing it: its end, else, once finished, an hour after its last change; null while it stays. */
    val disappearsAt: Instant?
        get() = endsAt ?: updatedAt.plus(FINISHED_KEPT).takeIf { isFinished }

    private companion object {
        val FINISHED_KEPT: Duration = Duration.ofHours(1)
    }
}

/** One change of a list made in the app. */
sealed interface ListChange {
    data class SetDone(val itemId: String, val done: Boolean) : ListChange

    data class EditItem(val itemId: String, val text: String) : ListChange

    data class AddItem(val listId: String, val text: String) : ListChange

    /** Moves the item to [toIndex] of its list. */
    data class MoveItem(val itemId: String, val toIndex: Int) : ListChange

    data class DeleteItem(val itemId: String) : ListChange

    data class RenameList(val listId: String, val name: String) : ListChange

    data class DeleteList(val listId: String) : ListChange
}

/** A list's "finished" row in the chat: the list's [name] and how many items it had, all ticked. */
data class FinishedList(val name: String, val total: Int)
