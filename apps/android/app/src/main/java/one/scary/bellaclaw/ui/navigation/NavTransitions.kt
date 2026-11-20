package one.scary.bellaclaw.ui.navigation

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.ui.unit.IntOffset
import androidx.navigation.NavBackStackEntry
import androidx.navigationevent.NavigationEvent

/*
 * The screen motion of both graphs. Forward, the new screen slides in from the end over the old one,
 * which slides out toward the start. Back, the leaving screen shrinks a little and slides off toward the
 * end while the screen below shows at rest, as Android's own back preview does; NavHost seeks the
 * predictive pair with the back gesture, which shifts the screen the way the finger moves.
 */
private val slideSpec = tween<IntOffset>(durationMillis = 300, easing = FastOutSlowInEasing)

internal val enterSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
    slideIntoContainer(SlideDirection.Start, slideSpec)
}

internal val exitSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
    slideOutOfContainer(SlideDirection.Start, slideSpec)
}

internal val popEnterAtRest: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
    EnterTransition.None
}

internal val popExitShrink: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
    scaleOut(targetScale = 0.9f) + slideOutOfContainer(SlideDirection.End, slideSpec)
}

internal val predictivePopEnterAtRest: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> EnterTransition = {
    EnterTransition.None
}

/** [edge]: the screen edge the gesture started from; the screen moves away from it, with the finger. */
internal val predictivePopExitShrink: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> ExitTransition = { edge ->
    if (edge == NavigationEvent.EDGE_RIGHT) {
        scaleOut(targetScale = 0.9f) + slideOutHorizontally(slideSpec) { -it }
    } else {
        scaleOut(targetScale = 0.9f) + slideOutHorizontally(slideSpec) { it }
    }
}
