package one.scary.bellaclaw.ui.settings

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SettingsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    @Test
    fun `summarises provider, main model, personality and theme and follows changes`() = runTest {
        val repository = SettingsRepository()
        val viewModel = SettingsViewModel(repository, gateway.repository())
        collectIn(viewModel.uiState)

        assertEquals(SettingsUiState("OpenCode Go", "Kimi K3.1 Pro", true, ThemeMode.SYSTEM, false), viewModel.uiState.value)

        repository.setProvider("openai-codex")
        repository.setThemeMode(ThemeMode.DARK)
        repository.savePersonality(repository.settings.value.personality.copy(useInChats = false))

        val state = viewModel.uiState.value
        assertEquals("Codex", state.providerName)
        assertEquals("GPT-5.5", state.mainModel)
        assertEquals(ThemeMode.DARK, state.themeMode)
        assertFalse(state.personalityInChats)
    }

    @Test
    fun `shows the account and its server`() = runTest {
        val viewModel = SettingsViewModel(SettingsRepository(), gateway.repository(gateway.signedInStore()))
        collectIn(viewModel.uiState)

        assertEquals("ada", viewModel.uiState.value.username)
        assertEquals(gateway.url, viewModel.uiState.value.serverUrl)
    }

    @Test
    fun `sign out ends the session on the server, then here`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = SettingsViewModel(SettingsRepository(), gateway.repository(store))
        collectIn(viewModel.uiState)
        gateway.answer(200, """{"ok":true}""", delayMillis = 300)

        viewModel.signOut()

        assertTrue(viewModel.uiState.value.isSigningOut)
        viewModel.uiState.first { !it.isSigningOut }
        val request = gateway.takeRequest()
        assertEquals("/api/logout", request.url.encodedPath)
        assertEquals("Bearer t0", request.headers["Authorization"])
        assertNull(store.session.value)
        assertNull(viewModel.uiState.value.signOutError)
    }

    @Test
    fun `a 401 on sign out ends the session too`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = SettingsViewModel(SettingsRepository(), gateway.repository(store))
        collectIn(viewModel.uiState)
        gateway.answer(401, errorAnswer("Unauthorized"))

        viewModel.signOut()
        viewModel.uiState.first { !it.isSigningOut }

        assertNull(store.session.value)
    }

    @Test
    fun `a 502 keeps the session and shows the server's text`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = SettingsViewModel(SettingsRepository(), gateway.repository(store))
        collectIn(viewModel.uiState)
        gateway.answer(502, errorAnswer("The assistant is unreachable"))

        viewModel.signOut()
        val state = viewModel.uiState.first { !it.isSigningOut }

        assertEquals("t0", store.session.value?.token)
        assertEquals(AccountError.Server(502, "The assistant is unreachable"), state.signOutError)
    }

    @Test
    fun `no network keeps the session`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = SettingsViewModel(SettingsRepository(), gateway.repository(store))
        collectIn(viewModel.uiState)
        gateway.server.close()

        viewModel.signOut()
        val state = viewModel.uiState.first { !it.isSigningOut }

        assertEquals("t0", store.session.value?.token)
        assertEquals(AccountError.Network, state.signOutError)
    }
}
