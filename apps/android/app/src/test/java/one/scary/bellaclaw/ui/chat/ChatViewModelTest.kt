package one.scary.bellaclaw.ui.chat

import androidx.lifecycle.SavedStateHandle
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.FakeGateway
import one.scary.bellaclaw.data.FakeGateway.Companion.BELLA_KEY
import one.scary.bellaclaw.data.FakeGateway.Companion.clientMessageId
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.modelAnswer
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

class ChatViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val testServer = TestServer()

    private lateinit var gateway: FakeGateway

    @Before
    fun setUp() {
        gateway = testServer.gateway()
    }

    private suspend fun TestScope.repository(foreground: Flow<Boolean> = MutableStateFlow(true)) =
        testServer.chatRepository(testServer.signedInStore(), backgroundScope, foreground)

    /** On the signed-in session's settings: Main on Kimi K3.1 Pro at its default effort, which lists low, medium and high. */
    private fun TestScope.viewModel(
        chatId: String,
        chatRepository: ChatRepository,
        savedStateHandle: SavedStateHandle = SavedStateHandle(),
        settings: SettingsRepository = testServer.settingsRepository(scope = backgroundScope),
    ) = ChatViewModel(chatId, chatRepository, settings, savedStateHandle, ZoneOffset.UTC).also { collectIn(it.uiState) }

    private fun ChatUiState.messages() = rows.filterIsInstance<ChatRow.Item>().map { it.message }

    /** Waits off the test thread, so the repository's work in the test scope keeps running meanwhile. */
    private suspend fun takeSend(): JsonObject =
        checkNotNull(withContext(Dispatchers.IO) { gateway.sends.poll(5, TimeUnit.SECONDS) }) { "no send arrived" }

    @Test
    fun `BellaClaw chat shows its history by author, images as placeholders, and an open stream`() = runTest {
        gateway.addRow(BELLA_KEY, "user", "!status")
        gateway.addRow(BELLA_KEY, "assistant", "All good.")
        gateway.addRow(BELLA_KEY, "user", "Look", imageIds = listOf("m1", null))
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())

        val state = viewModel.uiState.first { it.messages().size == 3 && it.isStreamOpen }

        assertEquals(ChatKind.BELLACLAW, state.kind)
        assertEquals(listOf("Look", "All good.", "!status"), state.messages().map { it.text })
        assertEquals(listOf(Author.USER, Author.ASSISTANT, Author.USER), state.messages().map { it.author })
        assertEquals(listOf(MessageImage("m1", "image/jpeg"), MessageImage(null, "image/jpeg")), state.messages()[0].images)
        assertFalse(state.isTyping)
    }

    @Test
    fun `history shows the newest 50 rows and pages older ones as the reader scrolls up`() = runTest {
        repeat(60) { gateway.addRow(BELLA_KEY, "assistant", "row ${it + 1}") }
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())

        val first = viewModel.uiState.first { it.messages().size == 50 }
        assertEquals("row 11", first.messages().last().text)

        viewModel.loadOlder()

        val paged = viewModel.uiState.first { it.messages().size == 60 }
        assertEquals("row 1", paged.messages().last().text)
        assertEquals("row 60", paged.messages().first().text)
    }

    @Test
    fun `a send shows pending, then the stored row and the reply the stream announces`() = runTest {
        gateway.addRow(BELLA_KEY, "assistant", "Hi")
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.messages().size == 1 }

        viewModel.onDraftChange("  Ship it  ")
        viewModel.send()

        val pending = viewModel.uiState.first { state -> state.messages().any { it.sendState == SendState.PENDING } }
        assertEquals("", pending.draft)
        assertEquals("Ship it", pending.messages().first().text)
        val body = takeSend()
        assertEquals("Ship it", body.getValue("text").jsonPrimitive.content)
        assertFalse("model" in body)

        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":true}""")
        viewModel.uiState.first { it.isTyping }
        gateway.addRow(BELLA_KEY, "user", "Ship it", clientMessageId = body.clientMessageId())
        gateway.addRow(BELLA_KEY, "assistant", "Shipped.")
        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":false}""")
        gateway.push("changed", """{"conversationKey":"$BELLA_KEY","revision":3,"rewriteRevision":0}""")

        val stored = viewModel.uiState.first { it.messages().size == 3 && !it.isTyping }
        assertEquals(listOf("Shipped.", "Ship it", "Hi"), stored.messages().map { it.text })
        assertEquals(setOf(SendState.STORED), stored.messages().map { it.sendState }.toSet())
    }

    @Test
    fun `a refused send shows the server's text and a retry sends it again with the same id`() = runTest {
        gateway.addChat("plain:ada:k1", "Kotlin")
        gateway.sendFailures.put(400 to errorAnswer("The provider has no API key"))
        val viewModel = viewModel("plain:ada:k1", repository())
        viewModel.uiState.first { it.title == "Kotlin" && it.isConversationKnown }

        viewModel.onDraftChange("Hello")
        viewModel.send()

        val failed = viewModel.uiState.first { state -> state.messages().any { it.sendState == SendState.FAILED } }.messages().single()
        assertEquals("The provider has no API key", failed.failure)
        val first = takeSend()
        assertEquals("""{"provider":"opencode-go","model":"kimi-k3.1-pro","effort":"medium"}""", first.getValue("model").toString())

        viewModel.retry(failed.id)

        assertEquals(first.clientMessageId(), takeSend().clientMessageId())
        viewModel.uiState.first { state -> state.messages().singleOrNull()?.sendState == SendState.STORED }
    }

    @Test
    fun `a confidential command settles once accepted, though history never has it`() = runTest {
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.isConversationKnown && it.isStreamOpen }

        viewModel.onDraftChange("!ai-auth openai")
        viewModel.send()
        takeSend()
        gateway.push("reply", """{"conversationKey":"$BELLA_KEY","text":"Open this link to sign in"}""")

        val settled = viewModel.uiState.first { state -> state.messages().size == 2 && state.messages().none { it.sendState != SendState.STORED } }
        assertEquals(listOf("Open this link to sign in", "!ai-auth openai"), settled.messages().map { it.text })
    }

    @Test
    fun `the open chat loads on the next check after its first read failed`() = runTest {
        gateway.addRow(BELLA_KEY, "assistant", "Hi")
        gateway.historyFailures.put(503)
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.isStreamOpen }
        withContext(Dispatchers.IO) {
            while (gateway.historyFailures.isNotEmpty()) {
                Thread.sleep(10)
            }
        }

        gateway.push("check", "{}")

        assertEquals("Hi", viewModel.uiState.first { it.messages().size == 1 }.messages().single().text)
    }

    @Test
    fun `the list loads and Send becomes available after its first read failed while the stream stays open`() = runTest {
        gateway.addRow(BELLA_KEY, "assistant", "Hi")
        gateway.listFailures.put(503)
        val repository = testServer.chatRepository(testServer.signedInStore(), backgroundScope, retryMillis = 10)
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository)
        viewModel.onDraftChange("Hello")

        val loaded = viewModel.uiState.first { it.canSend && it.messages().size == 1 }

        assertEquals("Hi", loaded.messages().single().text)
        assertEquals(1, gateway.streamsOpened)
    }

    @Test
    fun `Send is disabled and the draft kept until the chat's conversation is known`() = runTest {
        val foreground = MutableStateFlow(false)
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository(foreground))
        viewModel.onDraftChange("Hi")
        viewModel.send()

        val waiting = viewModel.uiState.first { it.draft == "Hi" }
        assertFalse(waiting.canSend)

        foreground.value = true
        viewModel.uiState.first { it.canSend }
        viewModel.send()

        viewModel.uiState.first { it.draft == "" && it.messages().size == 1 }
        assertEquals("Hi", takeSend().getValue("text").jsonPrimitive.content)
    }

    @Test
    fun `a deleted chat closes its screen`() = runTest {
        gateway.addChat("plain:ada:k1", "Kotlin")
        val viewModel = viewModel("plain:ada:k1", repository())
        viewModel.uiState.first { it.title == "Kotlin" }

        gateway.deleteChat("plain:ada:k1")
        gateway.push("deleted", """{"conversationKey":"plain:ada:k1"}""")

        viewModel.uiState.first { it.isMissing }
    }

    @Test
    fun `a reply shows once and stays when a removed row reloads the history`() = runTest {
        val removed = gateway.addRow(BELLA_KEY, "user", "Hello")
        gateway.addRow(BELLA_KEY, "assistant", "Kept")
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.messages().size == 2 }

        gateway.push("reply", """{"conversationKey":"$BELLA_KEY","text":"Open this link to sign in"}""")

        val shown = viewModel.uiState.first { it.messages().size == 3 }
        assertEquals(1, shown.messages().count { it.text == "Open this link to sign in" })
        assertEquals(Author.ASSISTANT, shown.messages().first().author)

        gateway.deleteRow(BELLA_KEY, removed)
        gateway.push("changed", """{"conversationKey":"$BELLA_KEY","revision":3,"rewriteRevision":3}""")

        val reloaded = viewModel.uiState.first { it.messages().size == 2 }
        assertEquals(setOf("Kept", "Open this link to sign in"), reloaded.messages().map { it.text }.toSet())
    }

    @Test
    fun `the stream is open in the foreground only`() = runTest {
        val foreground = MutableStateFlow(true)
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository(foreground))
        viewModel.uiState.first { it.isStreamOpen }

        foreground.value = false
        viewModel.uiState.first { !it.isStreamOpen }
        foreground.value = true

        viewModel.uiState.first { it.isStreamOpen }
        assertEquals(2, gateway.streamsOpened)
    }

    @Test
    fun `the picked model is kept on the phone and goes with the chat's sends`() = runTest {
        gateway.addChat("plain:ada:k1", "Kotlin")
        val repository = repository()
        val viewModel = viewModel("plain:ada:k1", repository)
        viewModel.uiState.first { it.title == "Kotlin" && it.isConversationKnown }

        viewModel.openModelPicker()
        val opened = viewModel.uiState.first { it.picker != null }.picker
        assertEquals(ModelChoice("opencode-go", "kimi-k3.1-pro", Effort.MEDIUM), opened?.selection)
        viewModel.onPickerModel("glm-5")
        viewModel.onPickerEffort(Effort.HIGH)
        viewModel.confirmModelPicker()
        val picked = ModelChoice("opencode-go", "glm-5", Effort.HIGH)
        // Stored once the chat shows it.
        repository.chat("plain:ada:k1").first { (it as? PlainChat)?.model == picked }

        val restarted = viewModel("plain:ada:k1", repository())
        restarted.uiState.first { it.title == "Kotlin" }
        restarted.openModelPicker()
        assertEquals(picked, restarted.uiState.first { it.picker != null }.picker?.selection)
        restarted.dismissModelPicker()
        restarted.onDraftChange("Hi")
        restarted.send()
        assertEquals("""{"provider":"opencode-go","model":"glm-5","effort":"high"}""", takeSend().getValue("model").toString())
    }

    @Test
    fun `reselecting the picker's current provider keeps the model, and dismissing drops the draft`() = runTest {
        gateway.addChat("plain:ada:k1", "Kotlin")
        val viewModel = viewModel("plain:ada:k1", repository())
        viewModel.uiState.first { it.title == "Kotlin" && it.isConversationKnown }

        viewModel.openModelPicker()
        viewModel.uiState.first { it.picker != null }
        viewModel.onPickerModel("glm-5")
        viewModel.onPickerProvider("opencode-go")
        assertEquals(ModelChoice("opencode-go", "glm-5", Effort.MEDIUM), viewModel.uiState.first { it.picker?.selection?.model == "glm-5" }.picker?.selection)

        viewModel.dismissModelPicker()
        viewModel.uiState.first { it.picker == null }
        viewModel.openModelPicker()
        assertEquals("kimi-k3.1-pro", viewModel.uiState.first { it.picker != null }.picker?.selection?.model)
    }

    @Test
    fun `a plain chat waits for the account's models, then sends Main's model at an effort it supports`() = runTest {
        gateway.addChat("plain:ada:k1", "Kotlin")
        testServer.route("GET", "/api/model", 503, errorAnswer("Unavailable"))
        val store = testServer.signedInStore()
        val settings = testServer.settingsRepository(store, backgroundScope)
        val viewModel = viewModel("plain:ada:k1", testServer.chatRepository(store, backgroundScope, settings = settings), settings = settings)
        settings.settings.first { it.models is Loadable.Failed }
        viewModel.uiState.first { it.title == "Kotlin" }
        viewModel.onDraftChange("Hello")

        viewModel.send()

        assertFalse(viewModel.uiState.first { it.draft == "Hello" }.canSend)

        // GLM 5 lists low and high, no medium.
        testServer.route("GET", "/api/model", 200, modelAnswer(mainModel = "glm-5"))
        settings.loadModels()
        viewModel.uiState.first { it.canSend }
        viewModel.send()

        assertEquals("""{"provider":"opencode-go","model":"glm-5","effort":"low"}""", takeSend().getValue("model").toString())
    }

    @Test
    fun `the draft survives a recreated ViewModel and a blank one does not send`() = runTest {
        val repository = repository()
        val savedStateHandle = SavedStateHandle()
        viewModel(BELLACLAW_CHAT_ID, repository, savedStateHandle).onDraftChange("Half a thought")

        val restored = viewModel(BELLACLAW_CHAT_ID, repository, savedStateHandle)
        assertEquals("Half a thought", restored.uiState.first { it.isStreamOpen }.draft)

        restored.onDraftChange("   ")
        restored.send()
        assertNull(withContext(Dispatchers.IO) { gateway.sends.poll(200, TimeUnit.MILLISECONDS) })
    }

    @Test
    fun `day rows get distinct keys when one date heads two sections`() {
        val now = Instant.parse("2026-11-19T12:00:00Z")
        val today = LocalDate.parse("2026-11-19")
        val earlier = now.minusSeconds(2 * 24 * 60 * 60)
        val messages = listOf(
            Message("a", "chat", Author.USER, "first", now),
            Message("b", "chat", Author.USER, "clock moved back", earlier),
            Message("c", "chat", Author.USER, "clock restored", now),
        )

        val days = chatRows(messages, ZoneOffset.UTC).filterIsInstance<ChatRow.Day>()

        assertEquals(listOf(today, today.minusDays(2), today), days.map { it.date })
        assertEquals(days.size, days.map { it.key }.toSet().size)
    }
}
