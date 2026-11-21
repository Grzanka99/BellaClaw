package one.scary.bellaclaw.ui.lists

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

/** [onBack] leaves the screen; [onGone] closes it once no list is left to show. */
@Composable
fun ListsRoute(
    onBack: () -> Unit,
    onGone: () -> Unit,
    viewModel: ListsViewModel = viewModel(factory = ListsViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(state.isGone) {
        if (state.isGone) {
            onGone()
        }
    }
    ListsScreen(
        state = state,
        onBack = onBack,
        events = ListsEvents(
            onSelect = viewModel::select,
            onToggle = viewModel::toggle,
            onStartEdit = viewModel::startEdit,
            onEditChange = viewModel::onEditChange,
            onCommitEdit = viewModel::commitEdit,
            onDelete = viewModel::delete,
            onMove = viewModel::move,
            onAddDraftChange = viewModel::onAddDraftChange,
            onAdd = viewModel::add,
            onOpenRename = viewModel::openRename,
            onRenameChange = viewModel::onRenameChange,
            onConfirmRename = viewModel::confirmRename,
            onOpenDelete = viewModel::openDelete,
            onConfirmDelete = viewModel::confirmDelete,
            onDismissDialog = viewModel::dismissDialog,
        ),
    )
}
