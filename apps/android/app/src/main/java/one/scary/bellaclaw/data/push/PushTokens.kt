package one.scary.bellaclaw.data.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** Where the FCM registration token comes from. */
interface PushTokens {
    /** The current token, or null when push is off. */
    suspend fun token(): String?

    /** Deletes the current token, so it no longer reaches this device. */
    suspend fun delete()
}

/**
 * FCM's tokens. Push is off (null, nothing deleted) when Firebase is not configured (a build without
 * `google-services.json`) or a token cannot be had (no Google Play services, no network).
 */
class FirebasePushTokens(private val context: Context) : PushTokens {
    override suspend fun token(): String? = messaging()?.token?.resultOrNull()

    override suspend fun delete() {
        messaging()?.deleteToken()?.resultOrNull()
    }

    private fun messaging(): FirebaseMessaging? {
        if (FirebaseApp.getApps(context).isEmpty()) {
            return null
        }
        return FirebaseMessaging.getInstance()
    }

    private suspend fun <T> Task<T>.resultOrNull(): T? = suspendCancellableCoroutine { continuation ->
        addOnCompleteListener { task ->
            continuation.resume(if (task.isSuccessful) task.result else null)
        }
    }
}
