package one.scary.bellaclaw.ui.signin

import androidx.lifecycle.SavedStateHandle
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
import one.scary.bellaclaw.model.LoginLink
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.model.PendingLink
import one.scary.bellaclaw.model.ServerUrlProblem
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class SignInViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    private fun TestScope.viewModel(accounts: AccountRepository = gateway.repository(), savedStateHandle: SavedStateHandle = SavedStateHandle()) =
        SignInViewModel(accounts, savedStateHandle).also { collectIn(it.uiState) }

    private fun SignInViewModel.fill(server: String, username: String = "ada", password: String = "pw") {
        onServerUrlChange(server)
        onUsernameChange(username)
        onPasswordChange(password)
    }

    @Test
    fun `signs in, loading meanwhile, and keeps the session`() = runTest {
        val accounts = gateway.repository()
        val viewModel = viewModel(accounts)
        val hold = gateway.hold()
        gateway.answer(200, sessionAnswer("ada", "t1"))

        viewModel.fill("${gateway.url}/", username = " ada ")
        viewModel.uiState.first { it.canSignIn }
        viewModel.signIn()

        viewModel.uiState.first { it.isLoading }
        hold.complete(Unit)
        accounts.session.first { it != null }
        val state = viewModel.uiState.first { !it.isLoading }
        assertNull(state.error)
        assertEquals(Session(gateway.url, "ada", "t1"), accounts.session.value)
        val request = gateway.takeRequest()
        assertEquals("/api/login", request.url.encodedPath)
        assertEquals("ada", request.json()["username"]?.jsonPrimitive?.content)
        assertEquals("pw", request.json()["password"]?.jsonPrimitive?.content)
    }

    @Test
    fun `shows the server's refusal and stays signed out`() = runTest {
        val accounts = gateway.repository()
        val viewModel = viewModel(accounts)
        gateway.answer(401, errorAnswer("Wrong username or password"))

        viewModel.fill(gateway.url)
        viewModel.uiState.first { it.canSignIn }
        viewModel.signIn()
        val state = viewModel.uiState.first { it.error != null && !it.isLoading }

        assertEquals(AccountError.Server(401, "Wrong username or password"), state.error)
        assertNull(accounts.session.value)
    }

    @Test
    fun `shows a network failure`() = runTest {
        val viewModel = viewModel()
        val url = gateway.url
        gateway.server.close()

        viewModel.fill(url)
        viewModel.uiState.first { it.canSignIn }
        viewModel.signIn()

        assertEquals(AccountError.Network, viewModel.uiState.first { it.error != null && !it.isLoading }.error)
    }

    @Test
    fun `refuses a bad server address without a request, and editing clears it`() = runTest {
        val viewModel = viewModel()

        viewModel.fill("bella.example.com")
        viewModel.signIn()

        assertEquals(AccountError.BadServerUrl(ServerUrlProblem.INVALID), viewModel.uiState.value.error)
        assertEquals(0, gateway.server.requestCount)
        viewModel.onServerUrlChange("https://bella.example.com")
        assertNull(viewModel.uiState.value.error)
    }

    @Test
    fun `starts from the last server, keeps server and username in saved state, never the password`() = runTest {
        val store = gateway.signedInStore("https://bella.example.com")
        store.end("t0")
        val savedStateHandle = SavedStateHandle()
        val viewModel = viewModel(gateway.repository(store), savedStateHandle)

        assertEquals("https://bella.example.com", viewModel.uiState.value.serverUrl)
        viewModel.fill("https://other.example.com", password = "secret")
        viewModel.onCodeChange("bellaclaw://login?token=secret-token")

        val restored = viewModel(gateway.repository(store), savedStateHandle)
        assertEquals("https://other.example.com", restored.uiState.value.serverUrl)
        assertEquals("ada", restored.uiState.value.username)
        assertEquals("", restored.uiState.value.password)
        assertEquals("", restored.uiState.value.code)
        val saved = savedStateHandle.keys().map { savedStateHandle.get<Any>(it).toString() }
        assertFalse(saved.any { it.contains("secret") })
    }

    @Test
    fun `a pasted code waits for confirmation and sends nothing`() = runTest {
        val accounts = gateway.repository()
        val viewModel = viewModel(accounts)

        viewModel.onCodeChange(" bellaclaw://login?server=https%3A%2F%2Fbella.example.com&token=t ")
        viewModel.useCode()

        assertEquals(PendingLink.Usable(LoginLink("https://bella.example.com", "t")), accounts.pendingLink.value)
        assertEquals("", viewModel.uiState.value.code)
        assertNull(viewModel.uiState.value.codeProblem)
        assertEquals(0, gateway.server.requestCount)
    }

    @Test
    fun `a pasted code that is not a usable link is refused in place`() = runTest {
        val accounts = gateway.repository()
        val viewModel = viewModel(accounts)

        viewModel.onCodeChange("https://bella.example.com/app?token=t")
        viewModel.useCode()

        assertEquals(LoginLinkProblem.NotALoginLink, viewModel.uiState.value.codeProblem)
        assertNull(accounts.pendingLink.value)
        viewModel.onCodeChange("bellaclaw://login?token=t")
        assertNull(viewModel.uiState.value.codeProblem)
        viewModel.useCode()
        assertEquals(LoginLinkProblem.Incomplete, viewModel.uiState.value.codeProblem)
    }

    @Test
    fun `the state's text leaves out the password and the code`() {
        val text = SignInUiState(password = "secret", code = "bellaclaw://login?token=tok").toString()
        assertFalse(text.contains("secret") || text.contains("tok"))
    }
}
