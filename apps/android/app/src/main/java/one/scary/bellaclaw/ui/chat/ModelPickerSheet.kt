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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.ui.components.EffortSelector
import one.scary.bellaclaw.ui.components.OptionDropdown

class ModelPickerEvents(
    val onProvider: (String) -> Unit,
    val onModel: (String) -> Unit,
    val onEffort: (Effort) -> Unit,
    val onDone: () -> Unit,
    val onDismiss: () -> Unit,
)

/** "Model for this chat": provider dropdown, the provider's models, effort, Done. The content scrolls when it is taller than the sheet. */
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
            OptionDropdown(
                label = stringResource(R.string.label_provider),
                options = state.providers,
                selected = state.provider,
                optionText = { it.name },
                onSelect = { events.onProvider(it.id) },
            )
            Spacer(Modifier.height(8.dp))
            Column(modifier = Modifier.selectableGroup()) {
                state.models.forEach { model ->
                    val selected = model == state.selection.model
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .selectable(selected = selected, onClick = { events.onModel(model) }, role = Role.RadioButton),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = selected, onClick = null)
                        Spacer(Modifier.padding(start = 16.dp))
                        Text(model, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            Text(
                stringResource(R.string.label_effort),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            EffortSelector(selected = state.effort, onSelect = events.onEffort)
            Spacer(Modifier.height(24.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Button(onClick = events.onDone) {
                    Text(stringResource(R.string.action_done))
                }
            }
        }
    }
}
