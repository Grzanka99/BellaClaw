package one.scary.bellaclaw.ui.settings

import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test

class SettingsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `summarises provider, main model, personality and theme and follows changes`() = runTest {
        val repository = SettingsRepository()
        val viewModel = SettingsViewModel(repository)
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
}
