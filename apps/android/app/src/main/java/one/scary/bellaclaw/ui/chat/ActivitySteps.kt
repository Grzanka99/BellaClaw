package one.scary.bellaclaw.ui.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ErrorOutline
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
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ActivityStep

private val IconCircle = 36.dp
private val RowGap = 12.dp

/**
 * A reply's activity in one card. While [isLive] it shows the typing dots and its [rows] as they come; done, it
 * folds into the step count and [seconds], and a tap unfolds the rows again.
 */
@Composable
fun ActivityCard(rows: List<ActivityRow>, seconds: Long, isLive: Boolean, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val open = rows.isNotEmpty() && (isLive || expanded)
    val radius by animateDpAsState(if (open) 20.dp else 14.dp, label = "radius")
    val shape = RoundedCornerShape(radius)
    Surface(
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceContainer,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier
            .animateContentSize()
            .clip(shape)
            .clickable(enabled = !isLive) { expanded = !expanded },
    ) {
        Column(modifier = if (open) Modifier.fillMaxWidth() else Modifier) {
            Row(
                modifier = Modifier.heightIn(min = 32.dp).padding(start = 10.dp, end = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Outlined.AutoAwesome,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(16.dp),
                )
                AnimatedContent(targetState = isLive, contentAlignment = Alignment.CenterStart, label = "header") { live ->
                    if (live) {
                        TypingIndicator()
                    } else {
                        Summary(rows.count { it is ActivityRow.Step }, seconds, expanded)
                    }
                }
            }
            AnimatedVisibility(
                visible = open,
                enter = expandVertically() + fadeIn(),
                exit = shrinkVertically() + fadeOut(),
            ) {
                ActivityRows(rows)
            }
        }
    }
}

/** "4 steps · 14s" and the chevron, turned up while [expanded]. */
@Composable
private fun Summary(steps: Int, seconds: Long, expanded: Boolean) {
    val rotation by animateFloatAsState(if (expanded) 180f else 0f, label = "chevron")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = pluralStringResource(R.plurals.activity_summary, steps, steps, seconds),
            style = MaterialTheme.typography.labelMedium,
        )
        Icon(
            Icons.Outlined.ExpandMore,
            contentDescription = stringResource(if (expanded) R.string.activity_hide else R.string.activity_show),
            modifier = Modifier.size(18.dp).rotate(rotation),
        )
    }
}

/** [rows] oldest first: steps running or done, and the pauses between them; a new row fades in. */
@Composable
private fun ActivityRows(rows: List<ActivityRow>) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(RowGap),
    ) {
        rows.forEachIndexed { index, row ->
            // A step keeps its key when it ends; the rows only grow at the end.
            val rowKey: Any = when (row) {
                is ActivityRow.Step -> row.step.startedAt to row.step.tool
                is ActivityRow.Thought -> "thought-$index"
                ActivityRow.Thinking -> "thinking"
            }
            key(rowKey) {
                val shown = remember { MutableTransitionState(false) }.apply { targetState = true }
                AnimatedVisibility(visibleState = shown, enter = fadeIn()) {
                    when (row) {
                        is ActivityRow.Step -> StepRow(row.step)
                        is ActivityRow.Thought -> Text(
                            text = stringResource(R.string.activity_thought, row.seconds),
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(start = IconCircle + RowGap),
                        )
                        ActivityRow.Thinking -> Row(horizontalArrangement = Arrangement.spacedBy(RowGap), verticalAlignment = Alignment.CenterVertically) {
                            StepIcon { Spinner() }
                            Text(
                                text = stringResource(R.string.activity_thinking),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StepRow(step: ActivityStep) {
    val duration = step.durationMs
    Row(horizontalArrangement = Arrangement.spacedBy(RowGap), verticalAlignment = Alignment.CenterVertically) {
        StepIcon {
            if (duration == null) {
                Spinner()
            } else if (step.failed) {
                Icon(
                    Icons.Outlined.ErrorOutline,
                    contentDescription = stringResource(R.string.activity_failed),
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(20.dp),
                )
            } else {
                Icon(
                    toolIcon(step.tool),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(text = step.label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
            if (step.detail.isNotEmpty()) {
                Text(text = step.detail, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (duration != null) {
            Text(text = stringResource(R.string.activity_duration, duration / 1000f), style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** A row's icon in a tinted circle. */
@Composable
private fun StepIcon(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier.size(IconCircle).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

/** Something in progress. */
@Composable
private fun Spinner() {
    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
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
