package one.scary.bellaclaw.ui.chat

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val now = Instant.parse("2026-11-19T12:00:00Z")
    private val today = LocalDate.parse("2026-11-19")

    private fun TestScope.chatRepository() = ChatRepository(backgroundScope, Clock.fixed(now, ZoneOffset.UTC))

    @get:Rule
    val gateway = TestServer()

    /** Signed in, with the server's models loaded: provider opencode-go and its models Kimi K3.1 Pro and GLM 5. */
    private suspend fun TestScope.viewModel(
        chatId: String,
        chatRepository: ChatRepository,
        savedStateHandle: SavedStateHandle = SavedStateHandle(),
    ): ChatViewModel {
        gateway.route("GET", "/api/model", 200, PICKER_MODELS)
        val settings = gateway.settingsRepository(gateway.signedInStore(), backgroundScope)
        settings.settings.first { it.providers.isNotEmpty() }
        return ChatViewModel(chatId, chatRepository, settings, savedStateHandle, ZoneOffset.UTC)
    }

    private fun ChatUiState.messages() = rows.filterIsInstance<ChatRow.Item>().map { it.message }

    @Test
    fun `BellaClaw chat shows its messages and an open stream`() = runTest {
        val viewModel = viewModel(BELLACLAW_CHAT_ID, chatRepository())
        collectIn(viewModel.uiState)

        val state = viewModel.uiState.value
        assertEquals(ChatKind.BELLACLAW, state.kind)
        assertEquals("Reminder set for 18:00.", state.messages().first().text)
        assertTrue(state.isStreamOpen)
        assertFalse(state.isTyping)
        assertFalse(state.canSend)
        assertFalse(state.isMissing)
    }

    @Test
    fun `rows come newest first with a day row above each day's messages`() = runTest {
        val viewModel = viewModel("sourdough", chatRepository())
        collectIn(viewModel.uiState)

        viewModel.onDraftChange("Still 75%?")
        viewModel.send()

        val rows = viewModel.uiState.value.rows
        assertEquals(5, rows.size)
        assertEquals("Still 75%?", (rows[0] as ChatRow.Item).message.text)
        assertEquals(ChatRow.Day(today, (rows[0] as ChatRow.Item).message.id), rows[1])
        assertEquals("sourdough-2", (rows[2] as ChatRow.Item).message.id)
        assertEquals("sourdough-1", (rows[3] as ChatRow.Item).message.id)
        assertEquals(ChatRow.Day(today.minusDays(3), "sourdough-1"), rows[4])
    }

    @Test
    fun `day rows get distinct keys when one date heads two sections`() {
        val earlier = now.minusSeconds(2 * 24 * 60 * 60)
        val messages = listOf(
            Message("a", "chat", Author.USER, "first", null, now),
            Message("b", "chat", Author.USER, "clock moved back", null, earlier),
            Message("c", "chat", Author.USER, "clock restored", null, now),
        )

        val days = chatRows(messages, ZoneOffset.UTC).filterIsInstance<ChatRow.Day>()

        assertEquals(listOf(today, today.minusDays(2), today), days.map { it.date })
        assertEquals(days.size, days.map { it.key }.toSet().size)
    }

    @Test
    fun `a chat id with no chat is reported missing`() = runTest {
        val viewModel = viewModel("created-in-an-earlier-process", chatRepository())
        collectIn(viewModel.uiState)

        assertTrue(viewModel.uiState.value.isMissing)
    }

    @Test
    fun `sending appends the message, clears the composer and shows typing for a moment`() = runTest {
        val viewModel = viewModel("kotlin-flow", chatRepository())
        collectIn(viewModel.uiState)

        viewModel.onDraftChange("  Thanks!  ")
        viewModel.onAttach("content://media/picker/1")
        assertTrue(viewModel.uiState.value.canSend)
        viewModel.send()
        runCurrent()

        val state = viewModel.uiState.value
        val last = state.messages().first()
        assertEquals("Thanks!", last.text)
        assertEquals("content://media/picker/1", last.imageUri)
        assertEquals(Author.USER, last.author)
        assertEquals("", state.draft)
        assertNull(state.attachmentUri)
        assertTrue(state.isTyping)

        advanceTimeBy(ChatRepository.SAMPLE_TYPING_MILLIS + 1)
        assertFalse(viewModel.uiState.value.isTyping)
    }

    @Test
    fun `typing lasts until the delay after the latest send, even when the sending screen is gone`() = runTest {
        val repository = chatRepository()
        val viewModel = viewModel("kotlin-flow", repository)
        collectIn(viewModel.uiState)

        viewModel.onDraftChange("One")
        viewModel.send()
        advanceTimeBy(ChatRepository.SAMPLE_TYPING_MILLIS / 2)
        val leavingScreen = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        leavingScreen.launch { repository.send("kotlin-flow", "Two", null) }
        leavingScreen.cancel()
        advanceTimeBy(ChatRepository.SAMPLE_TYPING_MILLIS / 2 + 1)
        assertTrue(viewModel.uiState.value.isTyping)

        advanceTimeBy(ChatRepository.SAMPLE_TYPING_MILLIS / 2)
        assertFalse(viewModel.uiState.value.isTyping)
    }

    @Test
    fun `the draft survives a recreated ViewModel`() = runTest {
        val repository = chatRepository()
        val savedStateHandle = SavedStateHandle()
        viewModel("kotlin-flow", repository, savedStateHandle).onDraftChange("Half a thought")

        val restored = viewModel("kotlin-flow", repository, savedStateHandle)
        collectIn(restored.uiState)

        assertEquals("Half a thought", restored.uiState.value.draft)
    }

    @Test
    fun `a blank draft does not send`() = runTest {
        val viewModel = viewModel("kotlin-flow", chatRepository())
        collectIn(viewModel.uiState)
        val before = viewModel.uiState.value.rows.size

        viewModel.onDraftChange("   ")
        viewModel.send()

        assertEquals(before, viewModel.uiState.value.rows.size)
    }

    @Test
    fun `removing the attachment empties it`() = runTest {
        val viewModel = viewModel("kotlin-flow", chatRepository())
        collectIn(viewModel.uiState)

        viewModel.onAttach("content://media/picker/1")
        viewModel.onRemoveAttachment()

        assertNull(viewModel.uiState.value.attachmentUri)
    }

    @Test
    fun `picker opens on the chat's model, edits a draft and stores it on Done`() = runTest {
        val viewModel = viewModel("kotlin-flow", chatRepository())
        collectIn(viewModel.uiState)

        viewModel.openModelPicker()
        val opened = viewModel.uiState.value.picker
        assertEquals(ModelChoice("opencode-go", "Kimi K3.1 Pro", Effort.LOW), opened?.selection)

        viewModel.onPickerModel("GLM 5")
        viewModel.onPickerEffort(Effort.HIGH)
        viewModel.confirmModelPicker()

        assertNull(viewModel.uiState.value.picker)
        viewModel.openModelPicker()
        assertEquals(
            ModelChoice("opencode-go", "GLM 5", Effort.HIGH),
            viewModel.uiState.value.picker?.selection,
        )
    }

    @Test
    fun `reselecting the picker's current provider keeps the model`() = runTest {
        val viewModel = viewModel("kotlin-flow", chatRepository())
        collectIn(viewModel.uiState)

        viewModel.openModelPicker()
        viewModel.onPickerModel("GLM 5")
        viewModel.onPickerProvider("opencode-go")

        assertEquals(ModelChoice("opencode-go", "GLM 5", Effort.LOW), viewModel.uiState.value.picker?.selection)
    }

    @Test
    fun `dismissing the picker drops the draft`() = runTest {
        val viewModel = viewModel("kotlin-flow", chatRepository())
        collectIn(viewModel.uiState)

        viewModel.openModelPicker()
        viewModel.onPickerEffort(Effort.HIGH)
        viewModel.dismissModelPicker()
        assertNull(viewModel.uiState.value.picker)

        viewModel.openModelPicker()
        assertEquals(Effort.LOW, viewModel.uiState.value.picker?.effort)
    }

    private companion object {
        const val PICKER_MODELS = """{"provider":"opencode-go","providers":["opencode-go"],""" +
            """"purposes":[{"purpose":"Main","model":"Kimi K3.1 Pro","effort":"low","serviceTier":"default"}],""" +
            """"availableModels":[{"id":"Kimi K3.1 Pro","name":"Kimi K3.1 Pro","supportedEfforts":["low","high"]},""" +
            """{"id":"GLM 5","name":"GLM 5","supportedEfforts":["low","high"]}]}"""
    }
}
