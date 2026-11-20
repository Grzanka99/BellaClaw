package one.scary.bellaclaw.ui.signin

import java.net.URLEncoder
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonPrimitive
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.json
import one.scary.bellaclaw.data.sessionAnswer
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.model.ServerUrlProblem
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class LinkViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    private fun linkTo(server: String, token: String = "link1") =
        "bellaclaw://login?server=${URLEncoder.encode(server, Charsets.UTF_8)}&token=$token"

    /** A view model on [accounts] with a link to the test server opened, as a deep link would. */
    private fun TestScope.openLink(accounts: AccountRepository, server: String = gateway.url): LinkViewModel {
        accounts.openLink(linkTo(server))
        val viewModel = LinkViewModel(accounts)
        collectIn(viewModel.uiState)
        return viewModel
    }

    /** Continues past the server and waits for the link check. */
    private suspend fun LinkViewModel.checked(answer: String): LinkUiState {
        gateway.answer(200, answer)
        check()
        return uiState.first { !it.isLoading }
    }

    @Test
    fun `a waiting link gives its confirmation as the first state, and nothing is sent before the user continues`() = runTest {
        val accounts = gateway.repository()
        accounts.openLink(linkTo(gateway.url))

        val state = LinkViewModel(accounts).uiState.value

        assertEquals(LinkStep.CONFIRM, state.step)
        assertEquals(gateway.url, state.serverUrl)
        assertEquals(0, gateway.server.requestCount)
    }

    @Test
    fun `continuing checks the link on its server, loading meanwhile`() = runTest {
        val viewModel = openLink(gateway.repository())
        gateway.answer(200, """{"valid":false}""", delayMillis = 300)

        viewModel.check()

        assertTrue(viewModel.uiState.value.isLoading)
        assertEquals(LinkStep.INVALID, viewModel.uiState.first { !it.isLoading }.step)
        val request = gateway.takeRequest()
        assertEquals("/api/link/check", request.url.encodedPath)
        assertEquals("link1", request.json()["token"]?.jsonPrimitive?.content)
        assertEquals("app", request.headers["X-BellaClaw-Client"])
    }

    @Test
    fun `a failed check stays on the confirmation with the error`() = runTest {
        val viewModel = openLink(gateway.repository())
        gateway.answer(502, errorAnswer("The assistant is unreachable"))

        viewModel.check()
        val state = viewModel.uiState.first { !it.isLoading }

        assertEquals(LinkStep.CONFIRM, state.step)
        assertEquals(AccountError.Server(502, "The assistant is unreachable"), state.error)
    }

    @Test
    fun `signed out, a linked chat shows the chat and its account, then signs in with the link only`() = runTest {
        val accounts = gateway.repository()
        val viewModel = openLink(accounts)

        val checked = viewModel.checked("""{"valid":true,"chatKey":"signal:+48123","username":"ada"}""")
        assertEquals(LinkStep.LINKED, checked.step)
        assertEquals("Signal +48123", checked.chat)
        assertEquals("ada", checked.accountName)
        gateway.takeRequest()

        gateway.answer(200, sessionAnswer("ada", "t1"))
        viewModel.signInLinked()

        assertTrue(viewModel.uiState.first { it.isMissing }.isMissing)
        assertEquals(Session(gateway.url, "ada", "t1"), accounts.session.value)
        assertNull(accounts.pendingLink.value)
        val request = gateway.takeRequest()
        assertEquals("/api/link/login", request.url.encodedPath)
        assertEquals(setOf("token"), request.json().keys)
    }

    @Test
    fun `signed out, a chat with no account shows the chat, then creates an account with the link`() = runTest {
        val accounts = gateway.repository()
        val viewModel = openLink(accounts)
        val checked = viewModel.checked("""{"valid":true,"chatKey":"discord:42"}""")
        assertEquals(LinkStep.UNLINKED, checked.step)
        assertEquals("Discord 42", checked.chat)
        assertTrue(checked.createAccount)
        gateway.takeRequest()

        viewModel.onUsernameChange("ada")
        viewModel.onPasswordChange("pw")
        gateway.answer(200, sessionAnswer("ada", "t1"))
        viewModel.uiState.first { it.canSubmitAccount }
        viewModel.submitAccount()
        viewModel.uiState.first { it.isMissing }

        assertEquals("t1", accounts.session.value?.token)
        val body = gateway.takeRequest().also { assertEquals("/api/register", it.url.encodedPath) }.json()
        assertEquals("link1", body["token"]?.jsonPrimitive?.content)
        assertEquals("ada", body["username"]?.jsonPrimitive?.content)
        assertFalse(body.containsKey("activationCode"))
    }

    @Test
    fun `signed out, a chat with no account signs in to an existing account with the link, and shows a refusal`() = runTest {
        val accounts = gateway.repository()
        val viewModel = openLink(accounts)
        viewModel.checked("""{"valid":true,"chatKey":"signal:+48123"}""")
        gateway.takeRequest()

        viewModel.onCreateAccountChange(false)
        viewModel.onUsernameChange("ada")
        viewModel.onPasswordChange("wrong")
        gateway.answer(401, errorAnswer("Wrong username or password"))
        viewModel.uiState.first { it.canSubmitAccount }
        viewModel.submitAccount()

        val state = viewModel.uiState.first { it.error != null }
        assertEquals(LinkStep.UNLINKED, state.step)
        assertFalse(state.createAccount)
        assertEquals(AccountError.Server(401, "Wrong username or password"), state.error)
        assertNull(accounts.session.value)
        val body = gateway.takeRequest().also { assertEquals("/api/login", it.url.encodedPath) }.json()
        assertEquals("link1", body["token"]?.jsonPrimitive?.content)
        assertEquals("wrong", body["password"]?.jsonPrimitive?.content)
    }

    @Test
    fun `signed in on the link's server, it checks the link, then offers to connect the chat it names`() = runTest {
        val accounts = gateway.repository(gateway.signedInStore())
        val viewModel = openLink(accounts)
        assertEquals(LinkStep.CONFIRM, viewModel.uiState.value.step)
        assertEquals(0, gateway.server.requestCount)

        val offer = viewModel.checked("""{"valid":true,"chatKey":"signal:+48123"}""")
        assertEquals(LinkStep.CONNECT, offer.step)
        assertEquals("Signal +48123", offer.chat)
        assertEquals("ada", offer.accountName)
        assertEquals("/api/link/check", gateway.takeRequest().url.encodedPath)

        gateway.answer(200, """{"username":"ada","chats":[]}""")
        viewModel.connect()

        viewModel.uiState.first { it.step == LinkStep.CONNECTED }
        val request = gateway.takeRequest()
        assertEquals("/api/link", request.url.encodedPath)
        assertEquals("Bearer t0", request.headers["Authorization"])
        assertEquals("link1", request.json()["token"]?.jsonPrimitive?.content)

        viewModel.dismiss()
        assertTrue(viewModel.uiState.first { it.isMissing }.isMissing)
        assertEquals("t0", accounts.session.value?.token)
    }

    @Test
    fun `signed in, a chat of this account already says so and connects nothing`() = runTest {
        val viewModel = openLink(gateway.repository(gateway.signedInStore()))

        val state = viewModel.checked("""{"valid":true,"chatKey":"signal:+48123","username":"ada"}""")

        assertEquals(LinkStep.ALREADY_CONNECTED, state.step)
        assertEquals("Signal +48123", state.chat)
        assertEquals(1, gateway.server.requestCount)
    }

    @Test
    fun `signed in, a chat of another account says so and connects nothing`() = runTest {
        val viewModel = openLink(gateway.repository(gateway.signedInStore()))

        val state = viewModel.checked("""{"valid":true,"chatKey":"signal:+48999","username":"eve"}""")

        assertEquals(LinkStep.OTHER_ACCOUNT, state.step)
        assertEquals("Signal +48999", state.chat)
        assertEquals("ada", state.accountName)
        assertEquals(1, gateway.server.requestCount)
    }

    @Test
    fun `a 401 while connecting ends the session and offers the signed-out choices`() = runTest {
        val accounts = gateway.repository(gateway.signedInStore())
        val viewModel = openLink(accounts)
        viewModel.checked("""{"valid":true,"chatKey":"signal:+48123"}""")
        gateway.answer(401, errorAnswer("Unauthorized"))

        viewModel.connect()
        viewModel.uiState.first { it.step == LinkStep.UNLINKED }

        assertNull(accounts.session.value)
    }

    @Test
    fun `signed in on another server, it says so and sends nothing`() = runTest {
        val accounts = gateway.repository(gateway.signedInStore("https://home.example.com"))
        val viewModel = openLink(accounts)

        val state = viewModel.uiState.value
        assertEquals(LinkStep.OTHER_SERVER, state.step)
        assertEquals("ada", state.accountName)
        assertEquals("https://home.example.com", state.signedInServer)
        assertEquals(0, gateway.server.requestCount)
        assertEquals("t0", accounts.session.value?.token)
    }

    @Test
    fun `an unusable link says why`() = runTest {
        val accounts = gateway.repository(allowCleartext = false)
        val viewModel = openLink(accounts, server = "http://bella.example.com")

        val state = viewModel.uiState.value
        assertEquals(LinkStep.UNUSABLE, state.step)
        assertEquals(LoginLinkProblem.BadServer(ServerUrlProblem.CLEARTEXT), state.problem)
        assertEquals(0, gateway.server.requestCount)
    }

    @Test
    fun `a link that arrives while one waits is dropped`() = runTest {
        val accounts = gateway.repository()
        val viewModel = openLink(accounts)

        accounts.openLink(linkTo("https://other.example.com", token = "link2"))

        assertEquals(gateway.url, viewModel.uiState.value.serverUrl)
        viewModel.dismiss()
        assertTrue(viewModel.uiState.first { it.isMissing }.isMissing)
        assertNull(accounts.pendingLink.value)
    }

    @Test
    fun `no waiting link means the screen closes`() = runTest {
        val viewModel = LinkViewModel(gateway.repository())
        collectIn(viewModel.uiState)

        assertTrue(viewModel.uiState.first { it.isMissing }.isMissing)
    }

    @Test
    fun `the state's text leaves out the password`() {
        assertFalse(LinkUiState(password = "secret").toString().contains("secret"))
    }
}
