package one.scary.bellaclaw.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.Lifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.newChatId
import one.scary.bellaclaw.ui.chat.ChatRoute
import one.scary.bellaclaw.ui.home.HomeRoute
import one.scary.bellaclaw.ui.lists.ListsRoute
import one.scary.bellaclaw.ui.settings.SettingsRoute
import one.scary.bellaclaw.ui.settings.models.ModelsRoute
import one.scary.bellaclaw.ui.settings.personality.PersonalityRoute
import one.scary.bellaclaw.ui.settings.theme.ThemeSettingsRoute
import one.scary.bellaclaw.ui.signin.LinkRoute

/**
 * The app's graph while signed in. Home sits under the BellaClaw chat, so Back from it lands on Home;
 * [chatToOpen], from a tapped notification, replaces whatever is above Home unless that chat is already on
 * top, and is then reported opened.
 * A screen navigates only while its entry is resumed, so repeated taps during a transition push or pop once.
 */
@Composable
fun BellaClawNavHost(hasPendingLink: Boolean, chatToOpen: String?, onChatOpened: () -> Unit) {
    val navController = rememberNavController()
    var openedBellaClaw by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!openedBellaClaw) {
            openedBellaClaw = true
            navController.navigate(ChatDestination(BELLACLAW_CHAT_ID))
        }
    }
    LaunchedEffect(chatToOpen) {
        if (chatToOpen != null) {
            val top = navController.currentBackStackEntry
            val isOnTop = top?.destination?.hasRoute<ChatDestination>() == true &&
                top.toRoute<ChatDestination>().chatId == chatToOpen
            if (!isOnTop) {
                navController.navigate(ChatDestination(chatToOpen)) { popUpTo(HomeDestination) }
            }
            onChatOpened()
        }
    }
    val onBack: NavBackStackEntry.() -> Unit = { ifResumed { navController.popBackStack() } }

    NavHost(
        navController = navController,
        startDestination = HomeDestination,
        enterTransition = enterSlide,
        exitTransition = exitSlide,
        popEnterTransition = popEnterSlide,
        popExitTransition = popExitSlide,
        predictivePopEnterTransition = predictivePopEnterSlide,
        predictivePopExitTransition = predictivePopExitSlide,
    ) {
        composable<HomeDestination> { entry ->
            HomeRoute(
                onOpenChat = { chatId -> entry.ifResumed { navController.navigate(ChatDestination(chatId)) } },
                onNewChat = { entry.ifResumed { navController.navigate(ChatDestination(newChatId())) } },
                onOpenSettings = { entry.ifResumed { navController.navigate(SettingsDestination) } },
            )
        }
        composable<ChatDestination> { entry ->
            ChatRoute(
                onBack = { entry.onBack() },
                // Not gated on resumed: a restored entry reports this before it resumes, and the pop is idempotent.
                onChatMissing = { navController.popBackStack(HomeDestination, inclusive = false) },
                onOpenList = { listId -> entry.ifResumed { navController.navigate(ListsDestination(listId)) } },
            )
        }
        composable<ListsDestination> { entry ->
            ListsRoute(
                onBack = { entry.onBack() },
                // Not gated on resumed, like a missing chat: the pop is idempotent.
                onGone = { navController.popBackStack<ListsDestination>(inclusive = true) },
            )
        }
        composable<SettingsDestination> { entry ->
            SettingsRoute(
                onBack = { entry.onBack() },
                onOpenModels = { entry.ifResumed { navController.navigate(ModelSettingsDestination) } },
                onOpenPersonality = { entry.ifResumed { navController.navigate(PersonalityDestination) } },
                onOpenTheme = { entry.ifResumed { navController.navigate(ThemeDestination) } },
            )
        }
        composable<ModelSettingsDestination> { entry ->
            ModelsRoute(onBack = { entry.onBack() })
        }
        composable<PersonalityDestination> { entry ->
            PersonalityRoute(onBack = { entry.onBack() })
        }
        composable<ThemeDestination> { entry ->
            ThemeSettingsRoute(onBack = { entry.onBack() })
        }
        composable<LinkDestination> {
            LinkRoute(onClose = { navController.popBackStack<LinkDestination>(inclusive = true) })
        }
    }
    PendingLinkEffect(navController, hasPendingLink)
}

/** Runs [action] only while this entry is the resumed, on-screen one. */
internal fun NavBackStackEntry.ifResumed(action: () -> Unit) {
    if (lifecycle.currentState == Lifecycle.State.RESUMED) {
        action()
    }
}
