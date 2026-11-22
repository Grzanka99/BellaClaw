package one.scary.bellaclaw.ui.navigation

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.ui.unit.IntOffset
import androidx.navigation.NavBackStackEntry

/*
 * The screen motion of both graphs. Forward, the new screen slides in from the right over the old one, which
 * moves a quarter to the left (400 ms, emphasized decelerate); back is the reverse, a bit faster (300 ms,
 * standard). The back gesture moves the same way, following the finger.
 */
private val forwardSpec = tween<IntOffset>(durationMillis = 400, easing = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f))
private val backSpec = tween<IntOffset>(durationMillis = 300, easing = CubicBezierEasing(0.2f, 0f, 0f, 1f))

// The back gesture seeks this by its progress, so a linear one keeps the screen under the finger.
private val gestureSpec = tween<IntOffset>(durationMillis = 300, easing = LinearEasing)

internal val enterSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
    slideInHorizontally(forwardSpec) { it }
}

internal val exitSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
    slideOutHorizontally(forwardSpec) { -it / 4 }
}

internal val popEnterSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
    slideInHorizontally(backSpec) { -it / 4 }
}

internal val popExitSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
    slideOutHorizontally(backSpec) { it }
}

internal val predictivePopEnterSlide: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> EnterTransition = {
    slideInHorizontally(gestureSpec) { -it / 4 }
}

internal val predictivePopExitSlide: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> ExitTransition = {
    slideOutHorizontally(gestureSpec) { it }
}
