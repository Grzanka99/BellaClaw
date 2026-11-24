package one.scary.bellaclaw.ui.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import androidx.compose.ui.util.lerp
import kotlinx.coroutines.launch

/** Material 3's emphasized easing. */
val EmphasizedEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/** Material 3's emphasized accelerate easing, for the card closing. */
private val EmphasizedAccelerateEasing = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)

/** A row starts fading in this long after the card starts opening, each next row [RowStagger] later. */
private const val RowDelayMs = 150f
private const val RowStagger = 40f
private const val RowFadeMs = 200f

/** Past every row's fade in: the rows show fully. */
private const val RowsShown = 100_000f

/**
 * A card folded to its [header] chip that opens to full width with its [body] below. Opening grows one box from
 * the chip to full width and down, and closing shrinks it back; the body's [rowCount] rows fade in one after
 * another, each by the fraction `shown(index)` gives. A tap calls [onClick] while [clickable]; when that opens or
 * closes it, [onResize] gets each frame's change in height, in pixels, so the list can move the rows below by it
 * and the header stays put.
 */
@Composable
fun FoldingCard(
    open: Boolean,
    rowCount: Int,
    clickable: Boolean,
    onClick: () -> Unit,
    onResize: (Float) -> Unit,
    modifier: Modifier = Modifier,
    header: @Composable () -> Unit,
    body: @Composable (shown: (Int) -> Float) -> Unit,
) {
    var tapped by remember { mutableStateOf(false) }
    val progress = remember { Animatable(if (open) 1f else 0f) }
    // The rows' clock in milliseconds since opening, and their fade out on closing.
    val reveal = remember { Animatable(if (open) RowsShown else 0f) }
    val fade = remember { Animatable(1f) }
    // The body's height, from the last layout.
    val bodyHeight = remember { IntArray(1) }
    LaunchedEffect(open) {
        val follow = tapped
        tapped = false
        var last = progress.value
        val onFrame: Animatable<Float, *>.() -> Unit = {
            if (follow) {
                onResize((value - last) * bodyHeight[0])
            }
            last = value
        }
        if (open) {
            fade.snapTo(1f)
            if (progress.value == 0f) {
                reveal.snapTo(0f)
            }
            launch {
                val end = RowDelayMs + RowStagger * (rowCount - 1) + RowFadeMs
                reveal.animateTo(end, tween(end.toInt(), easing = LinearEasing))
                reveal.snapTo(RowsShown)
            }
            progress.animateTo(1f, tween(450, easing = EmphasizedEasing), block = onFrame)
        } else {
            fade.animateTo(0f, tween(100))
            progress.animateTo(0f, tween(250, easing = EmphasizedAccelerateEasing), block = onFrame)
        }
    }
    val showBody by remember { derivedStateOf { progress.value > 0f } }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        // The corners follow the progress in the layer, so the card does not recompose every frame.
        modifier = modifier
            .graphicsLayer {
                shape = RoundedCornerShape(lerp(14.dp, 18.dp, progress.value))
                clip = true
            }
            .clickable(enabled = clickable) {
                tapped = true
                onClick()
            },
    ) {
        Layout(
            content = {
                header()
                if (showBody || open) {
                    body { index ->
                        val shown = ((reveal.value - RowDelayMs - RowStagger * index) / RowFadeMs).coerceIn(0f, 1f)
                        EmphasizedEasing.transform(shown) * fade.value
                    }
                }
            },
        ) { measurables, constraints ->
            val head = measurables[0].measure(constraints.copy(minWidth = 0, minHeight = 0))
            val rest = measurables.getOrNull(1)?.measure(Constraints.fixedWidth(constraints.maxWidth))
            bodyHeight[0] = rest?.height ?: 0
            val p = progress.value
            val width = lerp(head.width, constraints.maxWidth, p)
            val height = lerp(head.height, head.height + bodyHeight[0], p)
            layout(width, height) {
                head.place(0, 0)
                rest?.place(0, head.height)
            }
        }
    }
}

/** A row of a [FoldingCard]'s body showing by its [fraction], rising into place. */
fun Modifier.foldingRow(fraction: () -> Float): Modifier = graphicsLayer {
    val value = fraction()
    alpha = value
    translationY = (1f - value) * 8.dp.toPx()
}

/** The fold chevron, turned up while [expanded]. */
@Composable
fun FoldChevron(expanded: Boolean, contentDescription: String) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = tween(if (expanded) 300 else 200, easing = EmphasizedEasing),
        label = "chevron",
    )
    Icon(Icons.Outlined.ExpandMore, contentDescription = contentDescription, modifier = Modifier.size(18.dp).rotate(rotation))
}
