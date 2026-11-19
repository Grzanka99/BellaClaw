package one.scary.bellaclaw.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import one.scary.bellaclaw.model.Effort

@Composable
fun EffortSelector(selected: Effort, onSelect: (Effort) -> Unit, modifier: Modifier = Modifier) {
    val efforts = Effort.entries
    SingleChoiceSegmentedButtonRow(modifier = modifier.fillMaxWidth()) {
        efforts.forEachIndexed { index, effort ->
            SegmentedButton(
                selected = effort == selected,
                onClick = { onSelect(effort) },
                shape = SegmentedButtonDefaults.itemShape(index, efforts.size),
            ) {
                Text(stringResource(effort.label))
            }
        }
    }
}
