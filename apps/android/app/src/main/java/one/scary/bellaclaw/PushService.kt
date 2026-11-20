package one.scary.bellaclaw

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Receives FCM's data messages and new tokens and hands them to the push repository. Logs nothing. */
class PushService : FirebaseMessagingService() {
    private val push
        get() = (application as BellaClawApplication).container.pushRepository

    override fun onNewToken(token: String) {
        push.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val ciphertext = message.data["ciphertext"] ?: return
        push.receive(ciphertext)
    }
}
