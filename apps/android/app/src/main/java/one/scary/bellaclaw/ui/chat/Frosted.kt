package one.scary.bellaclaw.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import dev.chrisbanes.haze.HazeInput
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.blur.hazeBlur
import dev.chrisbanes.haze.blur.materials.HazeMaterials

/** How opaque a frosted element's own color is over the blur. */
const val GLASS_ALPHA = 0.75f

/**
 * Frosted glass for an element floating over the conversation: blurs what [hazeState] captures behind it,
 * clipped to [shape]. Give the element's own color [GLASS_ALPHA] so the blur shows through.
 */
@Composable
fun Modifier.frosted(hazeState: HazeState, shape: Shape): Modifier =
    clip(shape).hazeBlur(HazeInput.Sources(hazeState), HazeMaterials.ultraThin())
