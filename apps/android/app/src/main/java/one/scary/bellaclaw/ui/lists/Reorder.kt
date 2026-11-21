package one.scary.bellaclaw.ui.lists

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import one.scary.bellaclaw.model.TodoItem

/**
 * Drag to reorder the items of a lazy list on [listState]. While a row is dragged, [order] is the items as
 * dragged so far and the row is drawn [offset] off its place; it changes places with a row once its centre
 * enters that row. On release [onMove] gets the row's new index, if it moved.
 */
@Stable
class ReorderState(private val listState: LazyListState, private val onMove: (itemId: String, toIndex: Int) -> Unit) {
    var order by mutableStateOf(emptyList<TodoItem>())
        private set
    var draggedId by mutableStateOf<String?>(null)
        private set
    var offset by mutableFloatStateOf(0f)
        private set
    private var startIndex = -1

    fun start(itemId: String, items: List<TodoItem>) {
        order = items
        draggedId = itemId
        offset = 0f
        startIndex = items.indexOfFirst { it.id == itemId }
    }

    fun drag(dy: Float) {
        val id = draggedId ?: return
        offset += dy
        val visible = listState.layoutInfo.visibleItemsInfo
        val current = visible.firstOrNull { it.key == id } ?: return
        val center = (current.offset + offset + current.size / 2).toInt()
        val target = visible.firstOrNull { info ->
            info.key != id && order.any { it.id == info.key } && center in info.offset until info.offset + info.size
        } ?: return
        val from = order.indexOfFirst { it.id == id }
        val to = order.indexOfFirst { it.id == target.key }
        order = order.toMutableList().apply { add(to, removeAt(from)) }
        offset += current.offset - target.offset
    }

    fun end() {
        val id = draggedId ?: return
        val index = order.indexOfFirst { it.id == id }
        draggedId = null
        offset = 0f
        if (index != startIndex) {
            onMove(id, index)
        }
    }
}
