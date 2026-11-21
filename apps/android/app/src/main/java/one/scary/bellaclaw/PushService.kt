package one.scary.bellaclaw

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Receives FCM's data messages and new tokens and hands them to the push repository. Logs nothing. A
 * message's handling (its notification, the conversation's fetch) runs in the application scope; FCM
 * calls [onMessageReceived] off the main thread and keeps the process for it, so it waits for that
 * handling, within the time FCM gives a message.
 */
class PushService : FirebaseMessagingService() {
    private val push
        get() = (application as BellaClawApplication).container.pushRepository

    override fun onNewToken(token: String) {
        push.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val ciphertext = message.data["ciphertext"] ?: return
        push.receive(ciphertext)
        runBlocking { withTimeoutOrNull(HANDLE_MILLIS) { push.awaitHandled() } }
    }

    private companion object {
        /** FCM gives a data message about 10 s; a fetch still running after this goes on without the wait. */
        const val HANDLE_MILLIS = 9_000L
    }
}
