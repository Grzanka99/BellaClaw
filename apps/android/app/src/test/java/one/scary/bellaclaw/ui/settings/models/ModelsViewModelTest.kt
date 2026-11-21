package one.scary.bellaclaw.ui.settings.models

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.json
import one.scary.bellaclaw.data.modelAnswer
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ModelsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val gateway = TestServer()

    /** A view model whose models have loaded, on the signed-in session's settings unless [repository] says otherwise. */
    private suspend fun TestScope.loadedModels(repository: SettingsRepository? = null): ModelsViewModel {
        val viewModel = ModelsViewModel(repository ?: gateway.settingsRepository(gateway.signedInStore(), backgroundScope))
        collectIn(viewModel.uiState)
        viewModel.uiState.first { !it.isLoading }
        return viewModel
    }

    private fun ModelsUiState.row(role: ModelRole) = roles.single { it.role == role }

    @Test
    fun `shows the server's provider and roles once they load`() = runTest {
        val viewModel = ModelsViewModel(gateway.settingsRepository(gateway.signedInStore(), backgroundScope))
        collectIn(viewModel.uiState)
        assertTrue(viewModel.uiState.value.isLoading)

        val state = viewModel.uiState.first { !it.isLoading }

        assertEquals(listOf("opencode-go", "openai-codex"), state.providers)
        assertEquals("opencode-go", state.providerId)
        assertEquals(ModelRole.entries, state.roles.map { it.role })
        assertEquals(RoleRow(ModelRole.UTILITY, "GLM 5", Effort.LOW), state.row(ModelRole.UTILITY))
        assertEquals(RoleRow(ModelRole.MAIN, "Kimi K3.1 Pro", null), state.row(ModelRole.MAIN))
        assertEquals("Bearer t0", gateway.takeRequest("GET", "/api/model").headers["Authorization"])
    }

    @Test
    fun `a role change shows the server's answer once it is verified`() = runTest {
        val viewModel = loadedModels()
        // The server keeps the model's default effort, not the high one asked for.
        gateway.route("PUT", "/api/model", 200, modelAnswer(mainModel = "glm-5"))

        viewModel.openRole(ModelRole.MAIN)
        val editor = viewModel.uiState.first { it.editor != null }.editor
        assertEquals(listOf(null, Effort.LOW, Effort.MEDIUM, Effort.HIGH), editor?.efforts)
        viewModel.onEditorEffort(Effort.MEDIUM)
        viewModel.onEditorModel("glm-5")
        // GLM 5 has no medium effort: the model's default instead.
        assertNull(viewModel.uiState.first { it.editor?.model == "glm-5" }.editor?.effort)
        viewModel.onEditorEffort(Effort.HIGH)
        viewModel.saveRole()

        val changing = viewModel.uiState.first { it.isChanging }
        assertNull(changing.editor)
        assertEquals("Kimi K3.1 Pro", changing.row(ModelRole.MAIN).model)
        val state = viewModel.uiState.first { !it.isChanging }
        assertEquals(RoleRow(ModelRole.MAIN, "GLM 5", null), state.row(ModelRole.MAIN))
        assertNull(state.changeError)
        val body = gateway.takeRequest("PUT", "/api/model").json()
        assertEquals("Main", body["aiModelPurpose"]?.jsonPrimitive?.content)
        assertEquals("glm-5", body["aiModel"]?.jsonPrimitive?.content)
        assertEquals("high", body["aiReasoningEffort"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a refused change shows why and keeps the settings the server has`() = runTest {
        val viewModel = loadedModels()
        gateway.route("PUT", "/api/model", 400, errorAnswer("Provider openai-codex is not connected"))

        viewModel.selectProvider("openai-codex")

        val state = viewModel.uiState.first { it.changeError != null }
        assertEquals(AccountError.Server(400, "Provider openai-codex is not connected"), state.changeError)
        assertEquals("opencode-go", state.providerId)
        assertEquals("openai-codex", gateway.takeRequest("PUT", "/api/model").json()["aiProvider"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a refusal is still shown after reopening Models`() = runTest {
        val repository = gateway.settingsRepository(gateway.signedInStore(), backgroundScope)
        val viewModel = loadedModels(repository)
        gateway.route("PUT", "/api/model", 400, errorAnswer("Provider openai-codex is not connected"))
        viewModel.selectProvider("openai-codex")
        viewModel.uiState.first { it.changeError != null }
        gateway.takeRequest("PUT", "/api/model")

        // Meanwhile Main was changed in the dashboard; the reload shows it.
        gateway.route("GET", "/api/model", 200, modelAnswer(mainModel = "glm-5"))

        val reopened = ModelsViewModel(repository)
        collectIn(reopened.uiState)

        val state = reopened.uiState.first { !it.isLoading && it.row(ModelRole.MAIN).model == "GLM 5" }
        assertEquals(AccountError.Server(400, "Provider openai-codex is not connected"), state.changeError)
    }

    @Test
    fun `the role sheet closes when a reload no longer has its model`() = runTest {
        val viewModel = loadedModels()
        viewModel.openRole(ModelRole.MAIN)
        viewModel.uiState.first { it.editor != null }
        // The provider was changed in the dashboard: its catalog has no Kimi.
        val purposes = listOf("Utility", "Main", "Specialist", "SpecialistAccurate", "ScheduledTask").joinToString(",") {
            """{"purpose":"$it","model":"gpt-6","effort":"high"}"""
        }
        gateway.route(
            "GET",
            "/api/model",
            200,
            """{"provider":"openai-codex","providers":["opencode-go","openai-codex"],"purposes":[$purposes],""" +
                """"availableModels":[{"id":"gpt-6","name":"GPT 6","supportedEfforts":["low","high"]}]}""",
        )

        viewModel.retry()

        val state = viewModel.uiState.first { it.providerId == "openai-codex" && it.editor == null }
        assertEquals(RoleRow(ModelRole.MAIN, "GPT 6", Effort.HIGH), state.row(ModelRole.MAIN))
    }

    @Test
    fun `reset asks the server for the role's default`() = runTest {
        val viewModel = loadedModels()
        gateway.route("PUT", "/api/model", 200, modelAnswer())

        viewModel.openRole(ModelRole.UTILITY)
        viewModel.uiState.first { it.editor != null }
        viewModel.resetRole()
        viewModel.uiState.first { !it.isChanging }

        val body = withContext(Dispatchers.IO) { gateway.takeRequest("PUT", "/api/model") }.json()
        assertEquals("Utility", body["aiModelPurpose"]?.jsonPrimitive?.content)
        assertTrue(body["resetAiModel"]?.jsonPrimitive?.boolean == true)
    }

    @Test
    fun `a failed load shows why, and retry loads`() = runTest {
        gateway.route("GET", "/api/model", 502, errorAnswer("The assistant is unreachable"))
        val repository = gateway.settingsRepository(gateway.signedInStore(), backgroundScope)
        // The load when the session starts fails first; then the screen's own load.
        repository.settings.first { it.models is Loadable.Failed }
        val viewModel = ModelsViewModel(repository)
        collectIn(viewModel.uiState)

        val failed = viewModel.uiState.first { it.loadError != null }
        assertEquals(AccountError.Server(502, "The assistant is unreachable"), failed.loadError)

        gateway.route("GET", "/api/model", 200, modelAnswer())
        viewModel.retry()

        assertEquals("opencode-go", viewModel.uiState.first { !it.isLoading && it.loadError == null }.providerId)
    }
}
