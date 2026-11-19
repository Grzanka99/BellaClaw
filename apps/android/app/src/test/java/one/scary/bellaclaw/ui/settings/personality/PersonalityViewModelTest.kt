package one.scary.bellaclaw.ui.settings.personality

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PersonalityViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `shows the saved personality with nothing to save`() = runTest {
        val viewModel = PersonalityViewModel(SettingsRepository(), SavedStateHandle())
        collectIn(viewModel.uiState)

        val state = viewModel.uiState.value
        assertTrue(state.bellaClaw.startsWith("You are BellaClaw"))
        assertTrue(state.useInChats)
        assertEquals("Keep it short. Code examples in Kotlin.", state.chats)
        assertFalse(state.canSave)
        assertFalse(state.isSaved)
    }

    @Test
    fun `edits stay a draft until saved`() = runTest {
        val repository = SettingsRepository()
        val viewModel = PersonalityViewModel(repository, SavedStateHandle())
        collectIn(viewModel.uiState)

        viewModel.onUseInChatsChange(false)
        viewModel.onChatsChange("")
        viewModel.onBellaClawChange("Be brief.")

        val edited = viewModel.uiState.value
        assertEquals("Be brief.", edited.bellaClaw)
        assertFalse(edited.useInChats)
        assertTrue(edited.canSave)
        assertTrue(repository.settings.value.personality.useInChats)

        viewModel.save()

        val saved = repository.settings.value.personality
        assertEquals("Be brief.", saved.bellaClaw)
        assertFalse(saved.useInChats)
        assertEquals("", saved.chats)
        assertFalse(viewModel.uiState.value.canSave)
        assertTrue(viewModel.uiState.value.isSaved)

        viewModel.onSaveHandled()
        assertFalse(viewModel.uiState.value.isSaved)
    }

    @Test
    fun `the draft survives a recreated ViewModel`() = runTest {
        val repository = SettingsRepository()
        val savedStateHandle = SavedStateHandle()
        PersonalityViewModel(repository, savedStateHandle).onBellaClawChange("Be brief.")

        val restored = PersonalityViewModel(repository, savedStateHandle)
        collectIn(restored.uiState)

        assertEquals("Be brief.", restored.uiState.value.bellaClaw)
        assertTrue(restored.uiState.value.canSave)
    }

    @Test
    fun `undoing an edit leaves nothing to save`() = runTest {
        val viewModel = PersonalityViewModel(SettingsRepository(), SavedStateHandle())
        collectIn(viewModel.uiState)

        viewModel.onUseInChatsChange(false)
        viewModel.onUseInChatsChange(true)

        assertFalse(viewModel.uiState.value.canSave)
    }
}
