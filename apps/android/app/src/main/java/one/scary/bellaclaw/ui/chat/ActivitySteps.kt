package one.scary.bellaclaw.ui.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import androidx.compose.ui.util.lerp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ActivityStep
import kotlinx.coroutines.launch

private val IconCircle = 36.dp
private val RowGap = 12.dp

/** Material 3's emphasized easing. */
private val EmphasizedEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/** Material 3's emphasized accelerate easing, for the card closing. */
private val EmphasizedAccelerateEasing = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)

/** A row starts fading in this long after the card starts opening, each next row [RowStagger] later. */
private const val RowDelayMs = 150f
private const val RowStagger = 40f
private const val RowFadeMs = 200f

/** Past every row's fade in: the rows show fully. */
private const val RowsShown = 100_000f

/**
 * A reply's activity in one card. While [isLive] it shows the typing dots and its [rows] as they come; done, it
 * folds into the step count and [seconds], and a tap unfolds the rows again.
 * Opening grows one box from the header chip to full width and down, and closing shrinks it back. When a tap
 * opens or closes it, [onResize] gets each frame's change in height, in pixels, so the list can move the rows
 * below by it and the header stays put.
 */
@Composable
fun ActivityCard(
    rows: List<ActivityRow>,
    seconds: Long,
    isLive: Boolean,
    onResize: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var tapped by remember { mutableStateOf(false) }
    val open = rows.isNotEmpty() && (isLive || expanded)
    val progress = remember { Animatable(if (open) 1f else 0f) }
    // The rows' clock in milliseconds since opening, and their fade out on closing.
    val reveal = remember { Animatable(if (open) RowsShown else 0f) }
    val fade = remember { Animatable(1f) }
    // The rows' height, from the last layout.
    val rowsHeight = remember { IntArray(1) }
    LaunchedEffect(open) {
        val follow = tapped
        tapped = false
        var last = progress.value
        val onFrame: Animatable<Float, *>.() -> Unit = {
            if (follow) {
                onResize((value - last) * rowsHeight[0])
            }
            last = value
        }
        if (open) {
            fade.snapTo(1f)
            if (progress.value == 0f) {
                reveal.snapTo(0f)
            }
            launch {
                val end = RowDelayMs + RowStagger * (rows.size - 1) + RowFadeMs
                reveal.animateTo(end, tween(end.toInt(), easing = LinearEasing))
                reveal.snapTo(RowsShown)
            }
            progress.animateTo(1f, tween(450, easing = EmphasizedEasing), block = onFrame)
        } else {
            fade.animateTo(0f, tween(100))
            progress.animateTo(0f, tween(250, easing = EmphasizedAccelerateEasing), block = onFrame)
        }
    }
    val showRows by remember { derivedStateOf { progress.value > 0f } }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        // The corners follow the progress in the layer, so the card does not recompose every frame.
        modifier = modifier
            .graphicsLayer {
                shape = RoundedCornerShape(lerp(14.dp, 18.dp, progress.value))
                clip = true
            }
            .clickable(enabled = !isLive) {
                expanded = !expanded
                tapped = true
            },
    ) {
        Layout(
            content = {
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
                if (showRows || open) {
                    ActivityRows(rows, isLive) { index ->
                        val shown = ((reveal.value - RowDelayMs - RowStagger * index) / RowFadeMs).coerceIn(0f, 1f)
                        EmphasizedEasing.transform(shown) * fade.value
                    }
                }
            },
        ) { measurables, constraints ->
            val header = measurables[0].measure(constraints.copy(minWidth = 0, minHeight = 0))
            val body = measurables.getOrNull(1)?.measure(Constraints.fixedWidth(constraints.maxWidth))
            rowsHeight[0] = body?.height ?: 0
            val p = progress.value
            val width = lerp(header.width, constraints.maxWidth, p)
            val height = lerp(header.height, header.height + rowsHeight[0], p)
            layout(width, height) {
                header.place(0, 0)
                body?.place(0, header.height)
            }
        }
    }
}

/** "4 steps · 14s" and the chevron, turned up while [expanded]. */
@Composable
private fun Summary(steps: Int, seconds: Long, expanded: Boolean) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = tween(if (expanded) 300 else 200, easing = EmphasizedEasing),
        label = "chevron",
    )
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

/**
 * [rows] oldest first: steps running or done, and the pauses between them. Each row shows by its [shown]
 * fraction, rising into place; a row that comes while [isLive] also grows in.
 */
@Composable
private fun ActivityRows(rows: List<ActivityRow>, isLive: Boolean, shown: (Int) -> Float) {
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
                val visible = remember { MutableTransitionState(!isLive) }.apply { targetState = true }
                AnimatedVisibility(
                    visibleState = visible,
                    enter = expandVertically(expandFrom = Alignment.Top) + fadeIn(),
                    modifier = Modifier.graphicsLayer {
                        val fraction = shown(index)
                        alpha = fraction
                        translationY = (1f - fraction) * 8.dp.toPx()
                    },
                ) {
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
