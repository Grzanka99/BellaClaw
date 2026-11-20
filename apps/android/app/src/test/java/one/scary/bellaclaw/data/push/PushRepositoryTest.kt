package one.scary.bellaclaw.data.push

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonPrimitive
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.json
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.sessionAnswer
import one.scary.bellaclaw.model.AppPush
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class PushRepositoryTest {
    @get:Rule
    val server = TestServer()

    private val keys = newSoftwareKeys()
    private val tokens = FakeTokens("fcm-1")
    private val ok = """{"ok":true}"""

    private class FakeTokens(private val token: String) : PushTokens {
        val deleted = MutableStateFlow(false)

        override suspend fun token() = token

        override suspend fun delete() {
            deleted.value = true
        }
    }

    /** The account and push repositories on [store], sharing one client and lock as in the app. */
    private fun TestScope.repositories(store: SessionStore): Pair<AccountRepository, PushRepository> {
        val api = ApiClient(store)
        val lock = Mutex()
        // A real thread pool: the test blocks on takeRequest while the repository sends.
        val scope = CoroutineScope(backgroundScope.coroutineContext + Dispatchers.Default)
        return AccountRepository(api, store, true, lock) to PushRepository(api, store.session, lazyOf(keys), tokens, lock, scope)
    }

    @Test
    fun `the device registers after sign-in with its token and keys`() = runTest {
        val (account, _) = repositories(server.store())
        server.answer(200, sessionAnswer("ada", "t1"))
        server.answer(200, ok)

        account.signIn(server.url, "ada", "secret")

        assertEquals("/api/login", server.takeRequest().url.encodedPath)
        val device = server.takeRequest()
        assertEquals("PUT", device.method)
        assertEquals("/api/device", device.url.encodedPath)
        assertEquals("Bearer t1", device.headers["Authorization"])
        val body = device.json()
        assertEquals("fcm-1", body.getValue("fcmToken").jsonPrimitive.content)
        assertEquals(base64Url(keys.publicKey), body.getValue("publicKey").jsonPrimitive.content)
        assertEquals(base64Url(keys.authSecret), body.getValue("authSecret").jsonPrimitive.content)
    }

    @Test
    fun `the device registers on start with a session and again with a new token`() = runTest {
        server.answer(200, ok)
        server.answer(200, ok)
        val (_, push) = repositories(server.signedInStore())

        assertEquals("fcm-1", server.takeRequest().json().getValue("fcmToken").jsonPrimitive.content)
        push.onNewToken("fcm-2")
        assertEquals("fcm-2", server.takeRequest().json().getValue("fcmToken").jsonPrimitive.content)
    }

    @Test
    fun `after sign-out the device does not register and the token is deleted`() = runTest {
        server.answer(200, ok)
        server.answer(200, ok)
        val (account, push) = repositories(server.signedInStore())
        assertEquals("/api/device", server.takeRequest().url.encodedPath)

        assertNull(account.signOut())
        assertEquals("/api/logout", server.takeRequest().url.encodedPath)
        tokens.deleted.first { it }
        push.onNewToken("fcm-2")

        assertNull(server.server.takeRequest(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun `a push that decrypts arrives, one that does not is dropped`() = runTest {
        server.answer(200, ok)
        val (_, push) = repositories(server.signedInStore())
        val appPush = AppPush("bella:acct-1", kind = "bella", messageId = 3, revision = 9, text = "Hi", truncated = true)
        val json = """{"conversationKey":"bella:acct-1","kind":"bella","messageId":3,"revision":9,"text":"Hi","truncated":true}"""

        push.receive(encryptLikeServer(json, newSoftwareKeys()))
        push.receive(encryptLikeServer(json, keys))

        assertEquals(appPush, push.pushes.first())
    }
}
