package one.scary.bellaclaw.ui.settings.theme

import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ThemeSettingsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `mode and dynamic color apply at once`() = runTest {
        val viewModel = ThemeSettingsViewModel(SettingsRepository())
        collectIn(viewModel.uiState)
        assertEquals(ThemeSettingsUiState(ThemeMode.SYSTEM, dynamicColor = false), viewModel.uiState.value)

        viewModel.selectMode(ThemeMode.DARK)
        viewModel.setDynamicColor(true)

        assertEquals(ThemeSettingsUiState(ThemeMode.DARK, dynamicColor = true), viewModel.uiState.value)
    }
}
