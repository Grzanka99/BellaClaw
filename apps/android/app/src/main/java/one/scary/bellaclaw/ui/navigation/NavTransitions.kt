package one.scary.bellaclaw.ui.navigation

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.ui.unit.IntOffset
import androidx.navigation.NavBackStackEntry

/*
 * The screen motion of both graphs, a plain slide. Forward, the new screen slides in from the end and the
 * old one slides out toward the start; back is the reverse, and NavHost seeks it with the back gesture.
 */
private val slideSpec = tween<IntOffset>(durationMillis = 300, easing = FastOutSlowInEasing)

internal val enterSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
    slideIntoContainer(SlideDirection.Start, slideSpec)
}

internal val exitSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
    slideOutOfContainer(SlideDirection.Start, slideSpec)
}

internal val popEnterSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
    slideIntoContainer(SlideDirection.End, slideSpec)
}

internal val popExitSlide: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
    slideOutOfContainer(SlideDirection.End, slideSpec)
}

internal val predictivePopEnterSlide: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> EnterTransition = {
    slideIntoContainer(SlideDirection.End, slideSpec)
}

internal val predictivePopExitSlide: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> ExitTransition = {
    slideOutOfContainer(SlideDirection.End, slideSpec)
}
