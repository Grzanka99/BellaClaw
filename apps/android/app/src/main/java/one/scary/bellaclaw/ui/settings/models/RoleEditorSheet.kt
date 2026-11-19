package one.scary.bellaclaw.ui.settings.models

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.ui.components.EffortSelector
import one.scary.bellaclaw.ui.components.OptionDropdown
import one.scary.bellaclaw.ui.components.label

class RoleEditorEvents(
    val onModel: (String) -> Unit,
    val onEffort: (Effort) -> Unit,
    val onSave: () -> Unit,
    val onReset: () -> Unit,
    val onDismiss: () -> Unit,
)

/** One role's model and effort, with Reset to default and Save. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoleEditorSheet(state: RoleEditorState, events: RoleEditorEvents) {
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
            Text(stringResource(state.role.label), style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(16.dp))
            OptionDropdown(
                label = stringResource(R.string.label_model),
                options = state.models,
                selected = state.model,
                optionText = { it },
                onSelect = events.onModel,
            )
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
                TextButton(onClick = events.onReset) {
                    Text(stringResource(R.string.action_reset_default))
                }
                Spacer(Modifier.width(8.dp))
                Button(onClick = events.onSave) {
                    Text(stringResource(R.string.action_save))
                }
            }
        }
    }
}
