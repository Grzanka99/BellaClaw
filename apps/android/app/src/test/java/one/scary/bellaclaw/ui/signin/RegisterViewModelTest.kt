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
import one.scary.bellaclaw.model.ServerUrlProblem
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class RegisterViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    private fun TestScope.viewModel(accounts: AccountRepository = gateway.repository()) =
        RegisterViewModel(accounts, gateway.url, SavedStateHandle()).also { collectIn(it.uiState) }

    private fun RegisterViewModel.fill() {
        onUsernameChange("ada")
        onPasswordChange("pw")
        onActivationCodeChange(" code ")
    }

    @Test
    fun `creates the account with the activation code, loading meanwhile, and keeps the session`() = runTest {
        val accounts = gateway.repository()
        val viewModel = viewModel(accounts)
        val hold = gateway.hold()
        gateway.answer(200, sessionAnswer("ada", "t1"))

        assertEquals(gateway.url, viewModel.uiState.value.serverUrl)
        viewModel.fill()
        viewModel.uiState.first { it.canRegister }
        viewModel.register()

        viewModel.uiState.first { it.isLoading }
        hold.complete(Unit)
        accounts.session.first { it != null }
        assertNull(viewModel.uiState.first { !it.isLoading }.error)
        assertEquals(Session(gateway.url, "ada", "t1"), accounts.session.value)
        val request = gateway.takeRequest()
        assertEquals("/api/register", request.url.encodedPath)
        assertEquals("code", request.json()["activationCode"]?.jsonPrimitive?.content)
        assertFalse(request.json().containsKey("token"))
    }

    @Test
    fun `shows each refusal in the server's words`() = runTest {
        val accounts = gateway.repository()
        val refusals = listOf(
            400 to "Wrong activation code",
            409 to "This username is taken",
            403 to "Registration with an activation code is closed",
            429 to "Too many wrong activation codes. Try again in 15 minutes",
        )
        refusals.forEach { (status, text) ->
            val viewModel = viewModel(accounts)
            gateway.answer(status, errorAnswer(text))

            viewModel.fill()
            viewModel.uiState.first { it.canRegister }
            viewModel.register()

            assertEquals(AccountError.Server(status, text), viewModel.uiState.first { it.error != null && !it.isLoading }.error)
        }
        assertNull(accounts.session.value)
    }

    @Test
    fun `refuses http outside a debug build without a request`() = runTest {
        val viewModel = viewModel(gateway.repository(allowCleartext = false))

        viewModel.fill()
        viewModel.register()

        assertEquals(AccountError.BadServerUrl(ServerUrlProblem.CLEARTEXT), viewModel.uiState.value.error)
        assertEquals(0, gateway.server.requestCount)
    }

    @Test
    fun `needs every field`() = runTest {
        val viewModel = viewModel()

        viewModel.onUsernameChange("ada")
        viewModel.onPasswordChange("pw")
        assertFalse(viewModel.uiState.value.canRegister)
        viewModel.register()

        assertEquals(0, gateway.server.requestCount)
    }
}
