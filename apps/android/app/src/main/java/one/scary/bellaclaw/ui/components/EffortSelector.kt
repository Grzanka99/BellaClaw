package one.scary.bellaclaw.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.model.Effort

/** One chip per effort of [efforts], wrapping onto more lines when they do not fit the width. */
@Composable
fun EffortSelector(efforts: List<Effort>, selected: Effort, onSelect: (Effort) -> Unit, modifier: Modifier = Modifier) {
    FlowRow(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        efforts.forEach { effort ->
            FilterChip(
                selected = effort == selected,
                onClick = { onSelect(effort) },
                label = { Text(stringResource(effort.label)) },
            )
        }
    }
}
