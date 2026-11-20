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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.first
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.AiModel
import one.scary.bellaclaw.model.ChatProvider
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.ui.components.EffortSelector
import one.scary.bellaclaw.ui.components.LoadFailedContent
import one.scary.bellaclaw.ui.components.LoadingContent
import one.scary.bellaclaw.ui.components.OptionDropdown
import one.scary.bellaclaw.ui.theme.BellaClawTheme

class ModelPickerEvents(
    val onModel: (providerId: String, model: String) -> Unit,
    val onEffort: (Effort) -> Unit,
    val onRetry: () -> Unit,
    val onDone: () -> Unit,
    val onDismiss: () -> Unit,
)

/**
 * "Model for this chat": a select of the providers usable now, opening on the picked model's provider,
 * and that provider's models by name, or a line saying none is connected; the picked model's efforts;
 * Done. Loading, or the error with Retry, until a list is held. Only the models scroll, opening on the
 * picked model; the efforts and Done stay at the bottom.
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
    // Which provider's models show: the one chosen here, else the picked model's, else the first. Choosing one picks no model.
    var chosenId by rememberSaveable { mutableStateOf<String?>(null) }
    val shownId = chosenId ?: state.selection?.providerId
    val provider = providers.firstOrNull { it.id == shownId } ?: providers.firstOrNull()
    if (provider == null) {
        Text(
            stringResource(R.string.picker_no_provider),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else {
        OptionDropdown(
            label = stringResource(R.string.label_provider),
            options = providers,
            selected = provider,
            optionText = { it.id },
            onSelect = { chosenId = it.id },
        )
        Spacer(Modifier.height(8.dp))
        key(provider.id) {
            ProviderModels(provider, state, events)
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
        Button(onClick = events.onDone) {
            Text(stringResource(R.string.action_done))
        }
    }
}

/** The [provider]'s models, opening on the picked model when it is one of them; only this list scrolls. */
@Composable
private fun ColumnScope.ProviderModels(provider: ChatProvider, state: ModelPickerState, events: ModelPickerEvents) {
    val pickedIndex = remember {
        if (provider.id == state.selection?.providerId) {
            provider.models.indexOfFirst { it.id == state.selection.model }
        } else {
            -1
        }
    }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = pickedIndex.coerceAtLeast(0))
    // Once, after the first layout: centre the picked row. Later lists and picks leave the scroll alone,
    // and so does a sheet restored (a rotation) scrolled away from that row.
    LaunchedEffect(listState) {
        val layout = snapshotFlow { listState.layoutInfo }.first { it.visibleItemsInfo.isNotEmpty() }
        val row = layout.visibleItemsInfo.firstOrNull { it.index == pickedIndex } ?: return@LaunchedEffect
        val viewportCentre = (layout.viewportStartOffset + layout.viewportEndOffset) / 2
        listState.scrollBy((row.offset + row.size / 2 - viewportCentre).toFloat())
    }
    LazyColumn(state = listState, modifier = Modifier.weight(1f, fill = false).selectableGroup()) {
        items(provider.models) { model ->
            val selected = provider.id == state.selection?.providerId && model.id == state.selection.model
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .selectable(
                        selected = selected,
                        onClick = { events.onModel(provider.id, model.id) },
                        role = Role.RadioButton,
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = selected, onClick = null)
                Spacer(Modifier.padding(start = 16.dp))
                Text(model.name, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

private val noPickerEvents = ModelPickerEvents({ _, _ -> }, {}, {}, {}, {})

/** The sheet's content on its surface: a modal sheet does not show in a preview. */
@Composable
private fun PickerPreview(state: ModelPickerState) {
    BellaClawTheme {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
            Column(modifier = Modifier.padding(24.dp)) {
                ModelPickerContent(state.providers.valueOrNull.orEmpty(), state, noPickerEvents)
            }
        }
    }
}

@Preview
@Composable
private fun ModelPickerPreview() {
    val efforts = listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH)
    PickerPreview(
        ModelPickerState(
            providers = Loadable.Loaded(
                listOf(
                    ChatProvider("opencode-go", true, listOf(AiModel("kimi-k3.1-pro", "Kimi K3.1 Pro", efforts), AiModel("glm-5", "GLM 5", efforts))),
                    ChatProvider("openai-codex", true, listOf(AiModel("gpt-5.5", "GPT 5.5", efforts))),
                ),
            ),
            selection = ModelChoice("opencode-go", "glm-5", Effort.MEDIUM),
        ),
    )
}

@Preview
@Composable
private fun ModelPickerNoProviderPreview() {
    PickerPreview(ModelPickerState(providers = Loadable.Loaded(emptyList()), selection = null))
}
