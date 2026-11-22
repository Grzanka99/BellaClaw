package one.scary.bellaclaw.ui.lists

import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.TodoList

/** The item [itemId] being edited and its text so far. */
data class ItemEdit(val itemId: String, val text: String)

/** A dialog of the screen's menu. */
enum class ListDialog {
    RENAME,
    DELETE,
}

data class ListsUiState(
    /** Every list shown, for the chips; empty until the lists are read. */
    val lists: List<TodoList> = emptyList(),
    /** The list on screen: the one picked, else the first. */
    val list: TodoList? = null,
    /** True once the lists are read and none is left to show; the screen then closes. */
    val isGone: Boolean = false,
    /** The new item's text. */
    val addDraft: String = "",
    val editing: ItemEdit? = null,
    val dialog: ListDialog? = null,
    /** The name typed in the rename dialog. */
    val renameDraft: String = "",
    /** Why the last change was not made, until the next change. */
    val error: AccountError? = null,
)
