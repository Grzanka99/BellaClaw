package one.scary.bellaclaw.ui.lists

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.toRoute
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import one.scary.bellaclaw.data.ListsRepository
import one.scary.bellaclaw.model.ListChange
import one.scary.bellaclaw.model.TodoItem
import one.scary.bellaclaw.ui.appContainer
import one.scary.bellaclaw.ui.navigation.ListsDestination

/** The lists screen, opened on [listId]; the chips switch to another list, kept in [savedStateHandle]. */
class ListsViewModel(
    listId: String,
    private val listsRepository: ListsRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    /** What only this screen knows besides the drafts kept in [savedStateHandle]. */
    private data class LocalState(
        val editing: ItemEdit? = null,
        val dialog: ListDialog? = null,
        val renameDraft: String = "",
    )

    private val selected = savedStateHandle.getStateFlow(SELECTED_KEY, listId)
    private val addDraft = savedStateHandle.getMutableStateFlow(ADD_DRAFT_KEY, "")
    private val local = MutableStateFlow(LocalState())

    val uiState: StateFlow<ListsUiState> = combine(
        listsRepository.lists,
        listsRepository.error,
        selected,
        addDraft,
        local,
    ) { lists, error, selected, addDraft, local ->
        if (lists == null) {
            return@combine ListsUiState()
        }
        val list = lists.firstOrNull { it.id == selected } ?: lists.firstOrNull()
        ListsUiState(
            lists = lists,
            list = list,
            isGone = list == null,
            addDraft = addDraft,
            editing = local.editing,
            dialog = local.dialog,
            renameDraft = local.renameDraft,
            error = error,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ListsUiState())

    fun select(listId: String) {
        savedStateHandle[SELECTED_KEY] = listId
        local.update { it.copy(editing = null) }
    }

    fun toggle(item: TodoItem) {
        listsRepository.change(ListChange.SetDone(item.id, !item.done))
    }

    fun startEdit(item: TodoItem) {
        commitEdit()
        local.update { it.copy(editing = ItemEdit(item.id, item.text)) }
    }

    fun onEditChange(text: String) {
        local.update { state -> state.copy(editing = state.editing?.copy(text = text)) }
    }

    /** Saves the edited text if it changed; a blank text keeps the item as it was. */
    fun commitEdit() {
        val edit = local.value.editing ?: return
        local.update { it.copy(editing = null) }
        val text = edit.text.trim()
        val item = uiState.value.list?.items?.firstOrNull { it.id == edit.itemId } ?: return
        if (text.isNotEmpty() && text != item.text) {
            listsRepository.change(ListChange.EditItem(item.id, text))
        }
    }

    fun onAddDraftChange(text: String) {
        addDraft.value = text
    }

    /** Adds the draft as the list's last item. */
    fun add() {
        val list = uiState.value.list ?: return
        val text = addDraft.value.trim()
        if (text.isEmpty()) {
            return
        }
        listsRepository.change(ListChange.AddItem(list.id, text))
        addDraft.value = ""
    }

    fun delete(item: TodoItem) {
        if (local.value.editing?.itemId == item.id) {
            local.update { it.copy(editing = null) }
        }
        listsRepository.change(ListChange.DeleteItem(item.id))
    }

    fun move(itemId: String, toIndex: Int) {
        listsRepository.change(ListChange.MoveItem(itemId, toIndex))
    }

    fun openRename() {
        val list = uiState.value.list ?: return
        local.update { it.copy(dialog = ListDialog.RENAME, renameDraft = list.name) }
    }

    fun onRenameChange(text: String) {
        local.update { it.copy(renameDraft = text) }
    }

    fun confirmRename() {
        val list = uiState.value.list ?: return
        val name = local.value.renameDraft.trim()
        if (name.isEmpty()) {
            return
        }
        if (name != list.name) {
            listsRepository.change(ListChange.RenameList(list.id, name))
        }
        dismissDialog()
    }

    fun openDelete() {
        local.update { it.copy(dialog = ListDialog.DELETE) }
    }

    fun confirmDelete() {
        uiState.value.list?.let { listsRepository.change(ListChange.DeleteList(it.id)) }
        dismissDialog()
    }

    fun dismissDialog() {
        local.update { it.copy(dialog = null) }
    }

    fun errorShown() {
        listsRepository.clearError()
    }

    companion object {
        private const val SELECTED_KEY = "selectedList"
        private const val ADD_DRAFT_KEY = "addDraft"

        val Factory = viewModelFactory {
            initializer {
                val savedStateHandle = createSavedStateHandle()
                ListsViewModel(
                    listId = savedStateHandle.toRoute<ListsDestination>().listId,
                    listsRepository = appContainer().listsRepository,
                    savedStateHandle = savedStateHandle,
                )
            }
        }
    }
}
