package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
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
 * a list is held. The content scrolls when it is taller than the sheet.
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
                .verticalScroll(rememberScrollState())
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
private fun ModelPickerContent(providers: List<ChatProvider>, state: ModelPickerState, events: ModelPickerEvents) {
    Column(modifier = Modifier.selectableGroup()) {
        providers.forEach { provider ->
            Text(provider.id, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
            if (!provider.isUsable) {
                Text(
                    provider.reason.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            provider.models.forEach { model ->
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
