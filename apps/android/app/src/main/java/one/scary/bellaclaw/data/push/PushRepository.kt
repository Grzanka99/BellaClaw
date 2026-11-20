package one.scary.bellaclaw.data.push

import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.DeviceBody
import one.scary.bellaclaw.data.remote.OkBody
import one.scary.bellaclaw.model.AppPush
import one.scary.bellaclaw.model.Session

/**
 * Push for the signed-in account. The device registers (`PUT /api/device`) whenever a session starts
 * (sign-in, or app start with a session) and whenever FCM gives a new token, if there is a session
 * and a token; a failed registration waits for the next of those. It never registers while
 * [deviceLock] is held, which sign-out holds. Once a session ends, the FCM token is deleted. Pushes
 * that decrypt with [keys] arrive on [pushes] while the session they came in is still the session;
 * [awaitHandled] waits until the collector is done with them.
 */
class PushRepository(
    private val api: ApiClient,
    private val session: StateFlow<Session?>,
    private val keys: Lazy<DeviceKeys>,
    private val tokens: PushTokens,
    private val deviceLock: Mutex,
    private val scope: CoroutineScope,
) {
    /** Each push with the token of the session it arrived in. */
    private val received = Channel<Pair<String, AppPush>>(Channel.UNLIMITED)

    /** How many received pushes are not yet handled by the collector of [pushes]. */
    private val unhandled = MutableStateFlow(0)

    /**
     * Each decrypted push of the current session once, kept until it is collected. One collector; a push
     * counts as handled once the collector returns from it.
     */
    val pushes: Flow<AppPush> = flow {
        for ((sessionToken, push) in received) {
            try {
                if (sessionToken == session.value?.token) {
                    emit(push)
                }
            } finally {
                unhandled.update { it - 1 }
            }
        }
    }

    init {
        scope.launch {
            var hadSession = false
            session.map { it?.token }.distinctUntilChanged().collect { sessionToken ->
                if (sessionToken != null) {
                    hadSession = true
                    tokens.token()?.let { register(it) }
                } else if (hadSession) {
                    tokens.delete()
                }
            }
        }
    }

    /** FCM gave [fcmToken] in place of the last one. */
    fun onNewToken(fcmToken: String) {
        scope.launch { register(fcmToken) }
    }

    /** The FCM data field `ciphertext`; one that arrives signed out, or does not decrypt or parse, is dropped. */
    fun receive(ciphertext: String) {
        val sessionToken = session.value?.token ?: return
        val push = decryptPush(ciphertext, keys.value) ?: return
        unhandled.update { it + 1 }
        received.trySend(sessionToken to push)
    }

    /** Returns once every push received so far is handled. */
    suspend fun awaitHandled() {
        unhandled.first { it == 0 }
    }

    private suspend fun register(fcmToken: String) {
        deviceLock.withLock {
            if (session.value == null) {
                return
            }
            val encoder = Base64.getUrlEncoder().withoutPadding()
            val body = DeviceBody(fcmToken, encoder.encodeToString(keys.value.publicKey), encoder.encodeToString(keys.value.authSecret))
            api.putSignedIn<DeviceBody, OkBody>("/api/device", body)
        }
    }
}
