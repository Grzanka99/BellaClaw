package one.scary.bellaclaw.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController

/**
 * Opens the link confirmation when a login link starts waiting. Not gated on resumed: a link can arrive
 * at any moment, and the confirmation is pushed once. A link that arrives while one waits is dropped.
 */
@Composable
internal fun PendingLinkEffect(navController: NavHostController, hasPendingLink: Boolean) {
    LaunchedEffect(hasPendingLink) {
        if (hasPendingLink && navController.currentDestination?.hasRoute<LinkDestination>() != true) {
            navController.navigate(LinkDestination)
        }
    }
}
