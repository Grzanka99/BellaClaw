package one.scary.bellaclaw.ui.settings.theme

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.model.ThemeSettings
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ThemeSettingsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    @Test
    fun `mode and dynamic color apply at once and survive a restart`() = runTest {
        val viewModel = ThemeSettingsViewModel(gateway.settingsRepository(scope = backgroundScope))
        collectIn(viewModel.uiState)
        assertEquals(ThemeSettingsUiState(ThemeMode.SYSTEM, dynamicColor = false), viewModel.uiState.value)

        viewModel.selectMode(ThemeMode.DARK)
        viewModel.setDynamicColor(true)

        assertEquals(ThemeSettingsUiState(ThemeMode.DARK, dynamicColor = true), viewModel.uiState.first { it.dynamicColor })
        val restarted = gateway.settingsRepository(scope = backgroundScope)
        assertEquals(ThemeSettings(ThemeMode.DARK, dynamicColor = true), restarted.settings.value.theme)
    }
}
