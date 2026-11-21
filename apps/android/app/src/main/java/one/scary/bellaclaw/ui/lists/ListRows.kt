package one.scary.bellaclaw.ui.lists

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DragHandle
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.TodoItem

/**
 * An item: its checkbox, its text (a tap edits it in place; Done or leaving the field saves it) and a handle
 * to drag it. A swipe either way deletes it. The dragged row is drawn [dragOffset] off its place, above the others.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemRow(
    item: TodoItem,
    edit: ItemEdit?,
    isDragged: Boolean,
    dragOffset: Float,
    events: ListsEvents,
    onDragStart: () -> Unit,
    onDrag: (Float) -> Unit,
    onDragEnd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val swipe = rememberSwipeToDismissBoxState()
    SwipeToDismissBox(
        state = swipe,
        backgroundContent = {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.errorContainer),
            ) {
                Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
            }
        },
        gesturesEnabled = edit == null && !isDragged,
        onDismiss = { events.onDelete(item) },
        modifier = modifier
            .zIndex(if (isDragged) 1f else 0f)
            .graphicsLayer { translationY = dragOffset }
            .then(if (isDragged) Modifier.shadow(4.dp) else Modifier),
    ) {
        Surface(color = MaterialTheme.colorScheme.surface) {
            Column {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 4.dp, end = 4.dp),
            ) {
                Checkbox(checked = item.done, onCheckedChange = { events.onToggle(item) })
                if (edit != null) {
                    EditField(edit.text, onChange = events.onEditChange, onDone = events.onCommitEdit, modifier = Modifier.weight(1f))
                } else {
                    Text(
                        text = item.text,
                        style = MaterialTheme.typography.bodyLarge.copy(
                            textDecoration = if (item.done) TextDecoration.LineThrough else TextDecoration.None,
                        ),
                        color = if (item.done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f).clickable { events.onStartEdit(item) }.padding(vertical = 16.dp),
                    )
                }
                Icon(
                    imageVector = Icons.Outlined.DragHandle,
                    contentDescription = stringResource(R.string.list_reorder),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .size(48.dp)
                        .pointerInput(item.id) {
                            detectDragGestures(
                                onDragStart = { onDragStart() },
                                onDragEnd = onDragEnd,
                                onDragCancel = onDragEnd,
                                onDrag = { change, amount ->
                                    change.consume()
                                    onDrag(amount.y)
                                },
                            )
                        }
                        .padding(12.dp),
                )
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}

/** "Add…": Done adds the typed item and keeps the field open for the next. */
@Composable
fun AddRow(draft: String, onDraftChange: (String) -> Unit, onAdd: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp),
    ) {
        Icon(Icons.Outlined.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(modifier = Modifier.weight(1f).padding(start = 16.dp)) {
            if (draft.isEmpty()) {
                Text(
                    text = stringResource(R.string.list_add),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            ListTextField(value = draft, onChange = onDraftChange, onDone = onAdd, modifier = Modifier.fillMaxWidth())
        }
    }
}

/** The item's text being edited, focused when it opens; leaving it saves like Done. */
@Composable
private fun EditField(text: String, onChange: (String) -> Unit, onDone: () -> Unit, modifier: Modifier = Modifier) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    var wasFocused by remember { mutableStateOf(false) }
    ListTextField(
        value = text,
        onChange = onChange,
        onDone = onDone,
        modifier = modifier
            .padding(vertical = 16.dp)
            .focusRequester(focus)
            .onFocusChanged { state ->
                if (wasFocused && !state.isFocused) {
                    onDone()
                }
                wasFocused = state.isFocused
            },
    )
}

@Composable
private fun ListTextField(value: String, onChange: (String) -> Unit, onDone: () -> Unit, modifier: Modifier = Modifier) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = modifier,
    )
}
