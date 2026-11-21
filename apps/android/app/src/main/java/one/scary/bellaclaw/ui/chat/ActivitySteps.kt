package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.TravelExplore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ActivityStep

private val ChipShape = RoundedCornerShape(14.dp)
private val IconSlot = 20.dp

/**
 * A reply's activity above it: a chip with the step count and [seconds], which a tap opens into [rows]
 * and closes again.
 */
@Composable
fun ActivityChip(rows: List<ActivityRow>, seconds: Long, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val steps = rows.count { it is ActivityRow.Step }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Surface(
            shape = ChipShape,
            color = MaterialTheme.colorScheme.surfaceContainer,
            contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(ChipShape).clickable { expanded = !expanded },
        ) {
            Row(
                modifier = Modifier.padding(start = 10.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Outlined.AutoAwesome,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = pluralStringResource(R.plurals.activity_summary, steps, steps, seconds),
                    style = MaterialTheme.typography.labelMedium,
                )
                Icon(
                    if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                    contentDescription = stringResource(if (expanded) R.string.activity_hide else R.string.activity_show),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        if (expanded) {
            ActivitySteps(rows)
        }
    }
}

/** Activity as plain rows, oldest first: steps running or done, and the pauses between them. */
@Composable
fun ActivitySteps(rows: List<ActivityRow>, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            when (row) {
                is ActivityRow.Step -> StepRow(row.step)
                is ActivityRow.Thought -> Text(
                    text = stringResource(R.string.activity_thought, row.seconds),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = IconSlot + 10.dp),
                )
                ActivityRow.Thinking -> RunningRow(stringResource(R.string.activity_thinking))
            }
        }
    }
}

@Composable
private fun StepRow(step: ActivityStep) {
    val duration = step.durationMs
    if (duration == null) {
        RunningRow(step.label)
        return
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(modifier = Modifier.size(IconSlot), contentAlignment = Alignment.Center) {
            if (step.failed) {
                Icon(
                    Icons.Outlined.ErrorOutline,
                    contentDescription = stringResource(R.string.activity_failed),
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(18.dp),
                )
            } else {
                Icon(toolIcon(step.tool), contentDescription = null, tint = muted, modifier = Modifier.size(18.dp))
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(text = step.label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
            if (step.detail.isNotEmpty()) {
                Text(text = step.detail, style = MaterialTheme.typography.bodySmall, color = muted)
            }
        }
        Text(
            text = stringResource(R.string.activity_duration, duration / 1000f),
            style = MaterialTheme.typography.bodySmall,
            color = muted,
        )
    }
}

/** The icon of a done step, by its [tool]'s name. */
private fun toolIcon(tool: String): ImageVector = when (tool) {
    "web-search" -> Icons.Outlined.TravelExplore
    "web-fetch" -> Icons.Outlined.Language
    "delegate-memory" -> Icons.Outlined.Psychology
    "delegate-calendar" -> Icons.Outlined.CalendarMonth
    "delegate-scheduling", "delegate-automations" -> Icons.Outlined.Alarm
    "delegate-settings" -> Icons.Outlined.Settings
    "delegate-mcp", "resume-mcp", "cancel-mcp" -> Icons.Outlined.Hub
    else -> Icons.Outlined.Build
}

/** A spinner and [label]: something in progress. */
@Composable
private fun RunningRow(label: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(modifier = Modifier.size(IconSlot), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
        }
        Text(text = label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}
