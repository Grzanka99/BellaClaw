package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.first
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ChatProvider
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.ui.components.EffortSelector
import one.scary.bellaclaw.ui.components.LoadFailedContent
import one.scary.bellaclaw.ui.components.LoadingContent

class ModelPickerEvents(
    val onModel: (providerId: String, model: String) -> Unit,
    val onEffort: (Effort) -> Unit,
    val onRetry: () -> Unit,
    val onDone: () -> Unit,
    val onDismiss: () -> Unit,
)

/**
 * "Model for this chat": every provider with its models by name, a provider that cannot be used now
 * greyed out with its reason; the picked model's efforts; Done. Loading, or the error with Retry, until
 * a list is held. Only the providers and models scroll, opening on the picked model; the efforts and
 * Done stay at the bottom.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelPickerSheet(state: ModelPickerState, events: ModelPickerEvents) {
    ModalBottomSheet(
        onDismissRequest = events.onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 24.dp),
        ) {
            Text(stringResource(R.string.picker_title), style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(16.dp))
            when (val providers = state.providers) {
                Loadable.Loading -> LoadingContent(Modifier.height(160.dp))
                is Loadable.Failed -> LoadFailedContent(providers.error, events.onRetry)
                is Loadable.Loaded -> ModelPickerContent(providers.value, state, events)
            }
        }
    }
}

@Composable
private fun ColumnScope.ModelPickerContent(
    providers: List<ChatProvider>,
    state: ModelPickerState,
    events: ModelPickerEvents,
) {
    // The row the list opens on: the picked model's, else the first. A header row per provider, then its models.
    val pickedIndex = remember {
        var index = 0
        var picked = 0
        providers.forEach { provider ->
            index++
            provider.models.forEach { model ->
                if (provider.id == state.selection?.providerId && model.id == state.selection.model) {
                    picked = index
                }
                index++
            }
        }
        picked
    }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = pickedIndex)
    // Once, after the first layout: centre the picked row. Later lists and picks leave the scroll alone,
    // and so does a sheet restored (a rotation) scrolled away from that row.
    LaunchedEffect(listState) {
        val layout = snapshotFlow { listState.layoutInfo }.first { it.visibleItemsInfo.isNotEmpty() }
        val row = layout.visibleItemsInfo.firstOrNull { it.index == pickedIndex } ?: return@LaunchedEffect
        val viewportCentre = (layout.viewportStartOffset + layout.viewportEndOffset) / 2
        listState.scrollBy((row.offset + row.size / 2 - viewportCentre).toFloat())
    }
    LazyColumn(state = listState, modifier = Modifier.weight(1f, fill = false).selectableGroup()) {
        providers.forEach { provider ->
            item {
                Column {
                    Text(provider.id, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
                    if (!provider.isUsable) {
                        Text(
                            provider.reason.orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            items(provider.models) { model ->
                val selected = provider.id == state.selection?.providerId && model.id == state.selection.model
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp)
                        .selectable(
                            selected = selected,
                            enabled = provider.isUsable,
                            onClick = { events.onModel(provider.id, model.id) },
                            role = Role.RadioButton,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = selected, onClick = null, enabled = provider.isUsable)
                    Spacer(Modifier.padding(start = 16.dp))
                    Text(
                        model.name,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (provider.isUsable) Color.Unspecified else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
    val selection = state.selection
    if (selection != null) {
        Spacer(Modifier.height(16.dp))
        Text(
            stringResource(R.string.label_effort),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        EffortSelector(efforts = state.efforts, selected = selection.effort, onSelect = events.onEffort)
    }
    Spacer(Modifier.height(24.dp))
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Button(onClick = events.onDone, enabled = selection != null) {
            Text(stringResource(R.string.action_done))
        }
    }
}
