package one.scary.bellaclaw.ui.settings.models

import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ModelsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun ModelsUiState.row(role: ModelRole) = roles.single { it.role == role }

    @Test
    fun `shows the provider and five roles, marking the changed one custom`() = runTest {
        val viewModel = ModelsViewModel(SettingsRepository())
        collectIn(viewModel.uiState)

        val state = viewModel.uiState.value
        assertEquals("opencode-go", state.providerId)
        assertEquals(ModelRole.entries, state.roles.map { it.role })
        assertTrue(state.row(ModelRole.SPECIALIST_ACCURATE).isCustom)
        assertFalse(state.row(ModelRole.MAIN).isCustom)
    }

    @Test
    fun `editing a role and saving stores it and marks it custom`() = runTest {
        val viewModel = ModelsViewModel(SettingsRepository())
        collectIn(viewModel.uiState)

        viewModel.openRole(ModelRole.UTILITY)
        val editor = viewModel.uiState.value.editor
        assertEquals(RoleEditorState(ModelRole.UTILITY, listOf("Kimi K3.1 Pro", "Claude Haiku 5.5", "GLM 5"), "Claude Haiku 5.5", Effort.LOW), editor)

        viewModel.onEditorModel("GLM 5")
        viewModel.onEditorEffort(Effort.MEDIUM)
        viewModel.saveRole()

        val state = viewModel.uiState.value
        assertNull(state.editor)
        assertEquals(RoleRow(ModelRole.UTILITY, "GLM 5", Effort.MEDIUM, isCustom = true), state.row(ModelRole.UTILITY))
    }

    @Test
    fun `reset restores the default and dismiss keeps the stored value`() = runTest {
        val viewModel = ModelsViewModel(SettingsRepository())
        collectIn(viewModel.uiState)

        viewModel.openRole(ModelRole.SPECIALIST_ACCURATE)
        viewModel.resetRole()
        assertEquals(RoleRow(ModelRole.SPECIALIST_ACCURATE, "Kimi K3.1 Pro", Effort.LOW, false), viewModel.uiState.value.row(ModelRole.SPECIALIST_ACCURATE))

        viewModel.openRole(ModelRole.MAIN)
        viewModel.onEditorEffort(Effort.HIGH)
        viewModel.dismissEditor()
        assertNull(viewModel.uiState.value.editor)
        assertEquals(Effort.LOW, viewModel.uiState.value.row(ModelRole.MAIN).effort)
    }

    @Test
    fun `reselecting the current provider keeps custom roles`() = runTest {
        val viewModel = ModelsViewModel(SettingsRepository())
        collectIn(viewModel.uiState)

        viewModel.selectProvider("opencode-go")

        assertTrue(viewModel.uiState.value.row(ModelRole.SPECIALIST_ACCURATE).isCustom)
        assertEquals(Effort.HIGH, viewModel.uiState.value.row(ModelRole.SPECIALIST_ACCURATE).effort)
    }

    @Test
    fun `switching provider resets every role to that provider's defaults`() = runTest {
        val viewModel = ModelsViewModel(SettingsRepository())
        collectIn(viewModel.uiState)

        viewModel.selectProvider("openai-codex")

        val state = viewModel.uiState.value
        assertEquals("openai-codex", state.providerId)
        assertEquals("GPT-5.5", state.row(ModelRole.MAIN).model)
        assertTrue(state.roles.none { it.isCustom })
    }
}
