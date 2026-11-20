package one.scary.bellaclaw.ui.navigation

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.scaleOut
import androidx.compose.ui.unit.IntOffset
import androidx.navigation.NavBackStackEntry

/*
 * The screen motion of both graphs. Forward, the new screen slides in from the end over the old one,
 * which slides out toward the start. Back is Android's documented predictive back for Navigation Compose
 * (developer.android.com/develop/ui/compose/system/predictive-back-setup): the leaving screen scales down
 * to 90% around its centre while the screen below shows at rest; NavHost seeks it with the back gesture.
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
    scaleOut(targetScale = 0.9f)
}

internal val predictivePopEnterAtRest: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> EnterTransition = {
    EnterTransition.None
}

internal val predictivePopExitShrink: AnimatedContentTransitionScope<NavBackStackEntry>.(Int) -> ExitTransition = {
    scaleOut(targetScale = 0.9f)
}
