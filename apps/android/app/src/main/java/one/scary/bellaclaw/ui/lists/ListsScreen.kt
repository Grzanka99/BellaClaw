package one.scary.bellaclaw.ui.lists

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.TodoItem
import one.scary.bellaclaw.model.TodoList
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.components.text
import one.scary.bellaclaw.ui.components.formatEndTime
import one.scary.bellaclaw.ui.theme.BellaClawTheme
import java.time.Instant

/** The events of the lists screen. */
class ListsEvents(
    val onSelect: (String) -> Unit,
    val onToggle: (TodoItem) -> Unit,
    val onStartEdit: (TodoItem) -> Unit,
    val onEditChange: (String) -> Unit,
    val onCommitEdit: () -> Unit,
    val onDelete: (TodoItem) -> Unit,
    val onMove: (itemId: String, toIndex: Int) -> Unit,
    val onAddDraftChange: (String) -> Unit,
    val onAdd: () -> Unit,
    val onOpenRename: () -> Unit,
    val onRenameChange: (String) -> Unit,
    val onConfirmRename: () -> Unit,
    val onOpenDelete: () -> Unit,
    val onConfirmDelete: () -> Unit,
    val onDismissDialog: () -> Unit,
)

/** One list on its own screen: its progress, a chip per list when there are more, its items and a row to add one. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListsScreen(state: ListsUiState, onBack: () -> Unit, events: ListsEvents, modifier: Modifier = Modifier) {
    val list = state.list
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                navigationIcon = { BackButton(onBack) },
                title = { Text(list?.name.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                actions = { if (list != null) ListMenu(events) },
            )
        },
    ) { padding ->
        if (list == null) {
            return@Scaffold
        }
        val listState = rememberLazyListState()
        val onMove by rememberUpdatedState(events.onMove)
        val reorder = remember(listState) { ReorderState(listState) { id, index -> onMove(id, index) } }
        val items = if (reorder.draggedId != null) reorder.order else list.items
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize().padding(padding).imePadding()) {
            item(key = "header") {
                ListHeader(list, state.lists, error = state.error?.text(), onSelect = events.onSelect)
            }
            items(items, key = { it.id }) { item ->
                val isDragged = reorder.draggedId == item.id
                ItemRow(
                    item = item,
                    edit = state.editing?.takeIf { it.itemId == item.id },
                    isDragged = isDragged,
                    dragOffset = if (isDragged) reorder.offset else 0f,
                    events = events,
                    onDragStart = { reorder.start(item.id, list.items) },
                    onDrag = reorder::drag,
                    onDragEnd = reorder::end,
                    modifier = if (isDragged) Modifier else Modifier.animateItem(),
                )
            }
            item(key = "add") {
                AddRow(draft = state.addDraft, onDraftChange = events.onAddDraftChange, onAdd = events.onAdd)
            }
        }
    }
    when (state.dialog) {
        ListDialog.RENAME -> AlertDialog(
            onDismissRequest = events.onDismissDialog,
            title = { Text(stringResource(R.string.list_rename)) },
            text = {
                OutlinedTextField(
                    value = state.renameDraft,
                    onValueChange = events.onRenameChange,
                    label = { Text(stringResource(R.string.list_name)) },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = events.onConfirmRename, enabled = state.renameDraft.isNotBlank()) {
                    Text(stringResource(R.string.action_save))
                }
            },
            dismissButton = { TextButton(onClick = events.onDismissDialog) { Text(stringResource(R.string.action_cancel)) } },
        )
        ListDialog.DELETE -> AlertDialog(
            onDismissRequest = events.onDismissDialog,
            title = { Text(stringResource(R.string.list_delete_title, list?.name.orEmpty())) },
            text = { Text(stringResource(R.string.list_delete_text)) },
            confirmButton = { TextButton(onClick = events.onConfirmDelete) { Text(stringResource(R.string.list_delete)) } },
            dismissButton = { TextButton(onClick = events.onDismissDialog) { Text(stringResource(R.string.action_cancel)) } },
        )
        null -> Unit
    }
}

@Composable
private fun ListMenu(events: ListsEvents) {
    var isOpen by rememberSaveable { mutableStateOf(false) }
    Box {
        IconButton(onClick = { isOpen = true }) {
            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.list_actions))
        }
        DropdownMenu(expanded = isOpen, onDismissRequest = { isOpen = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.list_rename)) },
                onClick = {
                    isOpen = false
                    events.onOpenRename()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.list_delete)) },
                onClick = {
                    isOpen = false
                    events.onOpenDelete()
                },
            )
        }
    }
}

/** "3 of 7 · until today 20:00", the progress bar, why the last change was not made, and a chip per list when there is more than one. */
@Composable
private fun ListHeader(list: TodoList, lists: List<TodoList>, error: String?, onSelect: (String) -> Unit) {
    val total = list.items.size
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        val endsAt = list.endsAt
        Text(
            text = if (endsAt == null) {
                stringResource(R.string.list_progress, list.doneCount, total)
            } else {
                stringResource(R.string.list_progress_until, list.doneCount, total, formatEndTime(endsAt))
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        LinearProgressIndicator(
            progress = { if (total == 0) 0f else list.doneCount.toFloat() / total },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        error?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        if (lists.size > 1) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(top = 12.dp),
            ) {
                lists.forEach { other ->
                    FilterChip(
                        selected = other.id == list.id,
                        onClick = { onSelect(other.id) },
                        label = { Text(stringResource(R.string.list_chip, other.name, other.doneCount, other.items.size)) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = MaterialTheme.colorScheme.primary,
                            selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
                        ),
                    )
                }
            }
        }
    }
}

private val noEvents = ListsEvents({}, {}, {}, {}, {}, {}, { _, _ -> }, {}, {}, {}, {}, {}, {}, {}, {})

@Preview
@Composable
private fun ListsScreenPreview() {
    val now = Instant.now()
    val shopping = TodoList(
        "l1",
        "Shopping",
        now.plusSeconds(3_600),
        now,
        listOf(
            TodoItem("1", "Milk", true),
            TodoItem("2", "Bread", true),
            TodoItem("3", "Butter", false),
            TodoItem("4", "Coffee", false),
        ),
    )
    val packing = TodoList("l2", "Packing", null, now, listOf(TodoItem("5", "Charger", true), TodoItem("6", "Passport", false)))
    BellaClawTheme {
        ListsScreen(state = ListsUiState(lists = listOf(shopping, packing), list = shopping), onBack = {}, events = noEvents)
    }
}
