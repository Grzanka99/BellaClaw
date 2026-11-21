package one.scary.bellaclaw.ui.settings

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class SettingsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    /** On [store] for both the account and its settings. */
    private fun TestScope.viewModel(store: SessionStore, settings: SettingsRepository = gateway.settingsRepository(store, backgroundScope)) =
        SettingsViewModel(settings, gateway.repository(store)).also { collectIn(it.uiState) }

    @Test
    fun `summarises provider, main model, personality and theme once they load`() = runTest {
        val store = gateway.signedInStore()
        val repository = gateway.settingsRepository(store, backgroundScope)
        val viewModel = viewModel(store, repository)
        assertEquals(Loadable.Loading, viewModel.uiState.value.models)

        repository.setThemeMode(ThemeMode.DARK)
        val state = viewModel.uiState.first { it.models is Loadable.Loaded && it.personalityInChats is Loadable.Loaded }

        assertEquals(Loadable.Loaded(ModelsSummary("opencode-go", "Kimi K3.1 Pro")), state.models)
        assertEquals(Loadable.Loaded(true), state.personalityInChats)
        assertEquals(ThemeMode.DARK, state.themeMode)
    }

    @Test
    fun `signing out drops the account's settings and keeps the theme`() = runTest {
        val store = gateway.signedInStore()
        val repository = gateway.settingsRepository(store, backgroundScope)
        val viewModel = viewModel(store, repository)
        repository.setThemeMode(ThemeMode.DARK)
        viewModel.uiState.first { it.models is Loadable.Loaded && it.personalityInChats is Loadable.Loaded }
        gateway.route("POST", "/api/logout", 200, """{"ok":true}""")

        viewModel.signOut()

        val settings = repository.settings.first { it.models == Loadable.Loading }
        assertEquals(Loadable.Loading, settings.personality)
        assertEquals(ThemeMode.DARK, settings.theme.mode)
        assertNull(store.session.value)
    }

    @Test
    fun `shows the account and its server`() = runTest {
        val viewModel = viewModel(gateway.signedInStore())

        assertEquals("ada", viewModel.uiState.value.username)
        assertEquals(gateway.url, viewModel.uiState.value.serverUrl)
    }

    @Test
    fun `sign out ends the session on the server, then here`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = viewModel(store)
        val hold = gateway.hold()
        gateway.answer(200, """{"ok":true}""")

        viewModel.signOut()

        viewModel.uiState.first { it.isSigningOut }
        hold.complete(Unit)
        val state = viewModel.uiState.first { it.username.isEmpty() && !it.isSigningOut }
        val request = gateway.takeRequest("POST", "/api/logout")
        assertEquals("Bearer t0", request.headers["Authorization"])
        assertNull(state.signOutError)
        assertNull(store.session.value)
    }

    @Test
    fun `a 401 on sign out ends the session too`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = viewModel(store)
        gateway.answer(401, errorAnswer("Unauthorized"))

        viewModel.signOut()
        viewModel.uiState.first { it.username.isEmpty() && !it.isSigningOut }
        assertNull(store.session.value)
    }

    @Test
    fun `a 502 keeps the session and shows the server's text`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = viewModel(store)
        gateway.answer(502, errorAnswer("The assistant is unreachable"))

        viewModel.signOut()
        val state = viewModel.uiState.first { it.signOutError != null && !it.isSigningOut }

        assertEquals("t0", store.session.value?.token)
        assertEquals(AccountError.Server(502, "The assistant is unreachable"), state.signOutError)
    }

    @Test
    fun `no network keeps the session`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = viewModel(store)
        gateway.server.close()

        viewModel.signOut()
        val state = viewModel.uiState.first { it.signOutError != null && !it.isSigningOut }

        assertEquals("t0", store.session.value?.token)
        assertEquals(AccountError.Network, state.signOutError)
    }
}
