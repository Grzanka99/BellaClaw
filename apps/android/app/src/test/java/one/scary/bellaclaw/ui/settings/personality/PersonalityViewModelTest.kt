package one.scary.bellaclaw.ui.settings.personality

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.json
import one.scary.bellaclaw.data.personalityAnswer
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.Personality
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

    @get:Rule
    val gateway = TestServer()

    /** A view model whose personality has loaded, on the signed-in session's settings unless [repository] says otherwise. */
    private suspend fun TestScope.loadedPersonality(repository: SettingsRepository? = null): PersonalityViewModel {
        val viewModel = PersonalityViewModel(repository ?: gateway.settingsRepository(gateway.signedInStore(), backgroundScope), SavedStateHandle())
        collectIn(viewModel.uiState)
        viewModel.uiState.first { !it.isLoading }
        return viewModel
    }

    @Test
    fun `shows the server's personality with nothing to save`() = runTest {
        val viewModel = PersonalityViewModel(gateway.settingsRepository(gateway.signedInStore(), backgroundScope), SavedStateHandle())
        collectIn(viewModel.uiState)
        assertTrue(viewModel.uiState.value.isLoading)

        val state = viewModel.uiState.first { !it.isLoading }

        assertEquals("You are BellaClaw.", state.bellaClaw)
        assertTrue(state.useInChats)
        assertEquals("Keep it short.", state.chats)
        assertFalse(state.canSave)
    }

    @Test
    fun `saving sends the edits and shows the server's answer`() = runTest {
        val repository = gateway.settingsRepository(gateway.signedInStore(), backgroundScope)
        val viewModel = loadedPersonality(repository)
        gateway.route("PUT", "/api/personality", 200, personalityAnswer("Be brief.", useInChats = false, chats = ""))

        viewModel.onUseInChatsChange(false)
        viewModel.onChatsChange("")
        viewModel.onBellaClawChange("  Be brief.  ")
        assertTrue(viewModel.uiState.first { it.bellaClaw == "  Be brief.  " }.canSave)
        viewModel.save()

        val saved = viewModel.uiState.first { it.isSaved }
        assertEquals("Be brief.", saved.bellaClaw)
        assertFalse(saved.canSave)
        assertEquals(Loadable.Loaded(Personality("Be brief.", false, "")), repository.settings.value.personality)
        val body = gateway.takeRequest("PUT", "/api/personality").json()
        assertEquals("  Be brief.  ", body["bellaPersona"]?.jsonPrimitive?.content)
        assertFalse(body["plainChatsUseBellaPersona"]?.jsonPrimitive?.boolean ?: true)
        assertEquals("", body["plainChatsPersona"]?.jsonPrimitive?.content)

        viewModel.onSaveHandled()
        viewModel.uiState.first { !it.isSaved }
    }

    @Test
    fun `a refused save keeps the draft and shows the server's text`() = runTest {
        val viewModel = loadedPersonality()
        gateway.route("PUT", "/api/personality", 400, errorAnswer("bellaPersona must not be blank"))

        viewModel.onBellaClawChange(" ")
        viewModel.save()

        val state = viewModel.uiState.first { it.saveError != null }
        assertEquals(AccountError.Server(400, "bellaPersona must not be blank"), state.saveError)
        assertEquals(" ", state.bellaClaw)
        assertTrue(state.canSave)
        assertFalse(state.isSaved)
    }

    @Test
    fun `the draft survives a recreated ViewModel`() = runTest {
        val repository = gateway.settingsRepository(gateway.signedInStore(), backgroundScope)
        repository.settings.first { it.personality is Loadable.Loaded }
        val savedStateHandle = SavedStateHandle()
        PersonalityViewModel(repository, savedStateHandle).onBellaClawChange("Be brief.")

        val restored = PersonalityViewModel(repository, savedStateHandle)
        collectIn(restored.uiState)

        val state = restored.uiState.first { !it.isLoading }
        assertEquals("Be brief.", state.bellaClaw)
        assertTrue(state.canSave)
    }

    @Test
    fun `undoing an edit leaves nothing to save`() = runTest {
        val viewModel = loadedPersonality()

        viewModel.onUseInChatsChange(false)
        viewModel.onUseInChatsChange(true)

        assertFalse(viewModel.uiState.first { it.useInChats }.canSave)
    }
}
