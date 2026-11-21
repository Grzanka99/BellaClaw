package one.scary.bellaclaw.ui

import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.model.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AppViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    @Test
    fun `theme follows the settings`() = runTest {
        val repository = gateway.settingsRepository(scope = backgroundScope)
        val viewModel = AppViewModel(repository, gateway.repository())

        repository.setThemeMode(ThemeMode.LIGHT)

        assertEquals(ThemeMode.LIGHT, viewModel.uiState.value.theme.mode)
    }

    @Test
    fun `follows the session, from the stored one on`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = AppViewModel(gateway.settingsRepository(scope = backgroundScope), gateway.repository(store))

        assertTrue(viewModel.uiState.value.isSignedIn)

        store.end("t0")

        assertFalse(viewModel.uiState.value.isSignedIn)
    }

    @Test
    fun `a login link waits for confirmation without a request`() = runTest {
        val accounts = gateway.repository()
        val viewModel = AppViewModel(gateway.settingsRepository(scope = backgroundScope), accounts)

        viewModel.onLoginLink("bellaclaw://login?server=https%3A%2F%2Fbella.example.com&token=t")

        assertTrue(viewModel.uiState.value.hasPendingLink)
        assertEquals(0, gateway.server.requestCount)
    }

    @Test
    fun `an unusable login link waits too, so the confirmation can say why`() = runTest {
        val viewModel = AppViewModel(gateway.settingsRepository(scope = backgroundScope), gateway.repository())

        viewModel.onLoginLink("bellaclaw://login?token=t")

        assertTrue(viewModel.uiState.value.hasPendingLink)
    }

    @Test
    fun `a tapped notification opens its chat once, and only while signed in`() = runTest {
        val store = gateway.signedInStore()
        val viewModel = AppViewModel(gateway.settingsRepository(scope = backgroundScope), gateway.repository(store))

        viewModel.onOpenChat("plain:ada:a")
        assertEquals("plain:ada:a", viewModel.uiState.value.chatToOpen)
        viewModel.onChatOpened()
        assertNull(viewModel.uiState.value.chatToOpen)

        store.end("t0")
        viewModel.onOpenChat("plain:ada:a")

        assertNull(viewModel.uiState.value.chatToOpen)
    }
}
