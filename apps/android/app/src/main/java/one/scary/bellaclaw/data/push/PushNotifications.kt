package one.scary.bellaclaw.data.push

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.model.AppPush
import one.scary.bellaclaw.model.ChatNotification
import one.scary.bellaclaw.model.Session

/** Shows, replaces and clears the notifications; one per conversation key. */
interface Notifier {
    /** Shows [notification] in place of its conversation's; [alert] false updates it without a sound. */
    fun show(notification: ChatNotification, alert: Boolean)

    fun cancel(conversationKey: String)

    fun cancelAll()
}

/**
 * Turns each of [pushes] into a notification of its conversation, unless that chat's screen is open
 * while [foreground]. It shows at once with what [chats] knows, brings the conversation up to date
 * (for up to 8 s), then shows the chat's title and the row's whole text if they changed. A chat that opens on screen
 * loses its notification; a [session] change clears them all. Runs in [scope], for the whole process.
 */
class PushNotifications(
    pushes: Flow<AppPush>,
    private val chats: ChatRepository,
    private val session: StateFlow<Session?>,
    foreground: StateFlow<Boolean>,
    private val notifier: Notifier,
    scope: CoroutineScope,
) {
    /** Conversation keys of the chats on screen. */
    private val onScreen = combine(foreground, chats.openConversations) { isForeground, keys ->
        if (isForeground) keys else emptySet()
    }

    init {
        scope.launch { pushes.collect { handle(it) } }
        scope.launch { onScreen.collect { keys -> keys.forEach(notifier::cancel) } }
        scope.launch { session.map { it?.token }.distinctUntilChanged().drop(1).collect { notifier.cancelAll() } }
    }

    private suspend fun handle(push: AppPush) {
        val sessionToken = session.value?.token
        val first = chats.notificationOf(push)
        show(sessionToken, first, alert = true)
        // Bounded, so a stalled read never holds the next push back; a cut catch-up is left unfinished.
        // On Dispatchers.Default, so the bound counts real time whatever [scope] runs on.
        withContext(Dispatchers.Default) {
            withTimeoutOrNull(CATCH_UP_MILLIS) { chats.catchUp(push.conversationKey) }
        }
        val caughtUp = chats.notificationOf(push)
        if (caughtUp != first) {
            show(sessionToken, caughtUp, alert = false)
        }
    }

    private suspend fun show(sessionToken: String?, notification: ChatNotification, alert: Boolean) {
        if (sessionToken != session.value?.token || notification.conversationKey in onScreen.first()) {
            return
        }
        notifier.show(notification, alert)
    }

    private companion object {
        const val CATCH_UP_MILLIS = 8_000L
    }
}
