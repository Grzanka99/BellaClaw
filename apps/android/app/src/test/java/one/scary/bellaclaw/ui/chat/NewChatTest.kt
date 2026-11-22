package one.scary.bellaclaw.ui.chat

import androidx.lifecycle.SavedStateHandle
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.FakeGateway
import one.scary.bellaclaw.data.FakeGateway.Companion.clientMessageId
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.model.newChatId
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import one.scary.bellaclaw.ui.home.HomeViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.time.ZoneOffset

class NewChatTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val testServer = TestServer()

    private lateinit var gateway: FakeGateway

    @Before
    fun setUp() {
        gateway = testServer.gateway()
    }

    private suspend fun TestScope.repository() = testServer.chatRepository(testServer.signedInStore(), backgroundScope)

    private fun TestScope.newChat(repository: ChatRepository, savedStateHandle: SavedStateHandle, chatId: String) =
        ChatViewModel(chatId, repository, testServer.settingsRepository(scope = backgroundScope), testServer.listsRepository(testServer.store(), backgroundScope), savedStateHandle, ZoneOffset.UTC)
            .also { collectIn(it.uiState) }

    private fun ChatUiState.messages() = rows.filterIsInstance<ChatRow.Item>().map { it.message }

    /** Waits off the test thread, so the repository's work in the test scope keeps running meanwhile. */
    private suspend fun takeSend(): JsonObject =
        checkNotNull(withContext(Dispatchers.IO) { gateway.sends.poll(5, TimeUnit.SECONDS) }) { "no send arrived" }

    @Test
    fun `New chat opens ready to send with no request, and keeps its pick and draft through process death`() = runTest {
        val savedStateHandle = SavedStateHandle()
        val chatId = newChatId()
        val viewModel = newChat(repository(), savedStateHandle, chatId)

        val opened = viewModel.uiState.first { it.isReadyToSend && it.isStreamOpen }
        assertEquals(ChatKind.PLAIN, opened.kind)
        assertNull(opened.title)
        viewModel.openModelPicker()
        viewModel.uiState.first { it.picker?.providers is Loadable.Loaded }
        viewModel.onPickerModel("opencode-go", "glm-5")
        viewModel.confirmModelPicker()
        viewModel.uiState.first { it.picker == null }
        viewModel.onDraftChange("Half a thought")

        val restored = newChat(repository(), savedStateHandle, chatId)
        assertEquals("Half a thought", restored.uiState.first { it.isReadyToSend && it.isStreamOpen }.draft)
        assertEquals(0, gateway.createdChats)
        restored.send()

        assertEquals("""{"provider":"opencode-go","model":"glm-5","effort":"low"}""", takeSend().getValue("model").toString())
        assertEquals(1, gateway.createdChats)
    }

    @Test
    fun `the first send shows at once, creates the chat, then sends, and the screen and Home then have that chat`() = runTest {
        gateway.addChat("plain:ada:a", "Greeting")
        val created = CompletableDeferred<Unit>()
        testServer.route("POST", "/api/conversations", 200, """{"conversationKey":"plain:ada:a"}""", until = created)
        val repository = repository()
        val home = HomeViewModel(repository).also { collectIn(it.uiState) }
        val savedStateHandle = SavedStateHandle()
        val chatId = newChatId()
        val viewModel = newChat(repository, savedStateHandle, chatId)
        viewModel.uiState.first { it.isReadyToSend && it.isStreamOpen }

        viewModel.onDraftChange("Hello")
        viewModel.send()

        val sending = viewModel.uiState.first { it.messages().singleOrNull()?.sendState == SendState.PENDING }
        assertEquals("", sending.draft)
        assertTrue(gateway.sends.isEmpty())
        created.complete(Unit)
        val body = takeSend()
        assertEquals("Hello", body.getValue("text").jsonPrimitive.content)
        viewModel.uiState.first { it.title == "Greeting" && it.messages().singleOrNull()?.sendState == SendState.STORED }
        home.uiState.first { state -> state.chats.map { it.id } == listOf("plain:ada:a") }

        gateway.addRow("plain:ada:a", "user", "Hello", clientMessageId = body.clientMessageId())
        gateway.addRow("plain:ada:a", "assistant", "Hi there")
        gateway.push("changed", """{"conversationKey":"plain:ada:a","revision":2,"rewriteRevision":0}""")
        viewModel.uiState.first { state -> state.messages().map { it.text } == listOf("Hi there", "Hello") }

        // Restored after process death, it is that chat, not a new one.
        val restored = newChat(repository(), savedStateHandle, chatId)
        restored.uiState.first { state -> state.title == "Greeting" && state.messages().map { it.text } == listOf("Hi there", "Hello") }
    }

    @Test
    fun `a failed create shows the message as not sent, and a retry creates the chat and sends it`() = runTest {
        gateway.addChat("plain:ada:a")
        testServer.route("POST", "/api/conversations", 500, errorAnswer("Internal error"))
        val viewModel = newChat(repository(), SavedStateHandle(), newChatId())
        viewModel.uiState.first { it.isReadyToSend && it.isStreamOpen }

        viewModel.onDraftChange("Hello")
        viewModel.send()

        val failed = viewModel.uiState.first { it.messages().singleOrNull()?.sendState == SendState.FAILED }.messages().single()
        assertTrue(gateway.sends.isEmpty())
        testServer.route("POST", "/api/conversations", 200, """{"conversationKey":"plain:ada:a"}""")
        viewModel.retry(failed.id)

        assertEquals(failed.id, takeSend().clientMessageId())
        viewModel.uiState.first { it.messages().singleOrNull()?.sendState == SendState.STORED }
    }
}
