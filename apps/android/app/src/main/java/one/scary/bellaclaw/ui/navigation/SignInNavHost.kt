package one.scary.bellaclaw.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import one.scary.bellaclaw.ui.signin.LinkRoute
import one.scary.bellaclaw.ui.signin.RegisterRoute
import one.scary.bellaclaw.ui.signin.SignInRoute

/** The whole app while signed out: sign-in, account creation and the login link confirmation. */
@Composable
fun SignInNavHost(hasPendingLink: Boolean) {
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = SignInDestination) {
        composable<SignInDestination> { entry ->
            SignInRoute(
                onCreateAccount = { serverUrl ->
                    entry.ifResumed { navController.navigate(RegisterDestination(serverUrl)) }
                },
            )
        }
        composable<RegisterDestination> { entry ->
            RegisterRoute(onBack = { entry.ifResumed { navController.popBackStack() } })
        }
        composable<LinkDestination> {
            LinkRoute(onClose = { navController.popBackStack<LinkDestination>(inclusive = true) })
        }
    }
    PendingLinkEffect(navController, hasPendingLink)
}
