package one.scary.bellaclaw.ui.chat

import androidx.lifecycle.SavedStateHandle
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
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
import one.scary.bellaclaw.data.chatModelsAnswer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.modelAnswer
import one.scary.bellaclaw.model.ActivityStep
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ImageRefusal
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    /** A plain chat titled Kotlin, ready to send, on [chatRepository] and [settings]. */
    private suspend fun TestScope.kotlinChat(
        chatRepository: ChatRepository,
        settings: SettingsRepository = testServer.settingsRepository(scope = backgroundScope),
    ): ChatViewModel {
        gateway.addChat("plain:ada:k1", "Kotlin")
        val viewModel = viewModel("plain:ada:k1", chatRepository, settings = settings)
        viewModel.uiState.first { it.title == "Kotlin" && it.isReadyToSend }
        return viewModel
    }

    private fun ChatUiState.messages() = rows.filterIsInstance<ChatRow.Item>().map { it.message }

    private fun ChatUiState.liveCard() = (rows.firstOrNull() as? ChatRow.Activity)?.takeIf { it.isLive }

    /** Waits off the test thread, so the repository's work in the test scope keeps running meanwhile. */
    private suspend fun takeSend(): JsonObject =
        checkNotNull(withContext(Dispatchers.IO) { gateway.sends.poll(5, TimeUnit.SECONDS) }) { "no send arrived" }

    /** Polls [condition] off the test thread for at most 5 s, then fails naming [what]. */
    private suspend fun awaitTrue(what: String, condition: () -> Boolean) = withContext(Dispatchers.IO) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!condition()) {
            check(System.nanoTime() < deadline) { "Not within 5 s: $what" }
            Thread.sleep(10)
        }
    }

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
        assertNull(state.liveCard())
    }

    private suspend fun takeUpload(): Pair<String?, ByteArray> =
        checkNotNull(withContext(Dispatchers.IO) { gateway.uploads.poll(5, TimeUnit.SECONDS) }) { "no upload arrived" }

    private val photo = byteArrayOf(1, 2, 3)

    @Test
    fun `an image sends without text, shows at once from the picked file, uploads, then posts with the upload's answer`() = runTest {
        testServer.pickedImages.files["content://picked/1"] = "image/jpeg" to photo
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.isReadyToSend && it.isStreamOpen }

        viewModel.onAttach("content://picked/1")
        viewModel.uiState.first { it.attachmentUri == "content://picked/1" && it.canSend }
        viewModel.send()

        val shown = viewModel.uiState.first { it.messages().size == 1 }
        assertEquals(listOf(MessageImage(null, "image/jpeg", "content://picked/1")), shown.messages().single().images)
        assertNull(shown.attachmentUri)
        val (type, bytes) = takeUpload()
        assertEquals("image/jpeg", type)
        assertArrayEquals(photo, bytes)
        val body = takeSend()
        assertEquals("", body.getValue("text").jsonPrimitive.content)
        assertEquals("""[{"id":"media-1","mimeType":"image/jpeg"}]""", body.getValue("images").toString())

        gateway.addRow(BELLA_KEY, "user", "", clientMessageId = body.clientMessageId(), imageIds = listOf("media-1"))
        gateway.push("changed", """{"conversationKey":"$BELLA_KEY","revision":1,"rewriteRevision":0}""")

        viewModel.uiState.first { it.messages().singleOrNull()?.images?.singleOrNull()?.mediaId == "media-1" }
        // Kept from the upload, so it shows without a download.
        assertArrayEquals(photo, viewModel.imageFile("media-1")?.readBytes())
        assertEquals(0, gateway.downloads)
    }

    @Test
    fun `a refused upload shows the server's text, and a retry after a failed post does not upload again`() = runTest {
        testServer.pickedImages.files["content://picked/1"] = "image/png" to photo
        gateway.uploadFailures.put(413 to errorAnswer("The image is over 5 MB"))
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.isReadyToSend }
        viewModel.onAttach("content://picked/1")
        viewModel.uiState.first { it.attachmentUri != null && it.canSend }
        viewModel.send()

        val failed = viewModel.uiState.first { it.messages().singleOrNull()?.sendState == SendState.FAILED }.messages().single()
        assertEquals("The image is over 5 MB", failed.failure)
        takeUpload()

        gateway.sendFailures.put(503 to errorAnswer("Unavailable"))
        viewModel.retry(failed.id)
        takeUpload()
        takeSend()
        viewModel.uiState.first { state -> state.messages().single().let { it.sendState == SendState.FAILED && it.failure == null } }

        viewModel.retry(failed.id)
        val body = takeSend()
        viewModel.uiState.first { it.messages().single().sendState == SendState.STORED }
        assertEquals("""[{"id":"media-1","mimeType":"image/png"}]""", body.getValue("images").toString())
        assertTrue(gateway.uploads.isEmpty())
    }

    @Test
    fun `an image over 5 MB, with or without a reported size, or of a type the server does not take, is refused on the phone`() = runTest {
        testServer.pickedImages.files["content://picked/ok"] = "image/webp" to photo
        testServer.pickedImages.files["content://picked/big"] = "image/jpeg" to ByteArray(5 * 1024 * 1024 + 1)
        testServer.pickedImages.files["content://picked/unsized"] = "image/jpeg" to ByteArray(5 * 1024 * 1024 + 1)
        testServer.pickedImages.sizeUnknown += "content://picked/unsized"
        testServer.pickedImages.files["content://picked/heic"] = "image/heic" to photo
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.onAttach("content://picked/ok")
        viewModel.uiState.first { it.attachmentUri == "content://picked/ok" }

        viewModel.onAttach("content://picked/big")

        val tooLarge = viewModel.uiState.first { it.attachmentRefusal == ImageRefusal.TOO_LARGE }
        assertEquals("content://picked/ok", tooLarge.attachmentUri)
        viewModel.onAttach("content://picked/heic")
        viewModel.uiState.first { it.attachmentRefusal == ImageRefusal.UNSUPPORTED_TYPE }
        viewModel.onAttach("content://picked/unsized")
        viewModel.uiState.first { it.attachmentRefusal == ImageRefusal.TOO_LARGE }
        viewModel.onRemoveAttachment()
        viewModel.uiState.first { it.attachmentUri == null && it.attachmentRefusal == null }
    }

    @Test
    fun `Send waits while a picked image is checked, and comes back when the image is removed or attached`() = runTest {
        testServer.pickedImages.files["content://picked/1"] = "image/jpeg" to photo
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.onDraftChange("Look")
        viewModel.uiState.first { it.canSend }
        val opening = CompletableDeferred<Unit>()
        testServer.pickedImages.opening = opening

        viewModel.onAttach("content://picked/1")

        viewModel.uiState.first { it.isCheckingAttachment && !it.canSend }
        viewModel.onRemoveAttachment()
        viewModel.uiState.first { !it.isCheckingAttachment && it.canSend }
        opening.complete(Unit)
        viewModel.onAttach("content://picked/1")
        viewModel.uiState.first { it.attachmentUri == "content://picked/1" && it.canSend }
    }

    @Test
    fun `history's images download once and stay until the session ends, and a gone one stays a placeholder`() = runTest {
        gateway.addMedia("m1", photo)
        gateway.addRow(BELLA_KEY, "user", "Look", imageIds = listOf("m1", "m2"))
        val store = testServer.signedInStore()
        val viewModel = viewModel(BELLACLAW_CHAT_ID, testServer.chatRepository(store, backgroundScope))
        viewModel.uiState.first { it.messages().size == 1 }

        val file = checkNotNull(viewModel.imageFile("m1"))
        assertArrayEquals(photo, file.readBytes())
        assertEquals(file, viewModel.imageFile("m1"))
        assertEquals(1, gateway.downloads)
        assertNull(viewModel.imageFile("m2"))

        store.end("t0")

        awaitTrue("the image file is deleted") { !file.exists() }
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
        viewModel.uiState.first { it.messages().size == 1 && it.isStreamOpen }

        viewModel.onDraftChange("  Ship it  ")
        viewModel.send()

        val pending = viewModel.uiState.first { state -> state.messages().any { it.sendState == SendState.PENDING } }
        assertEquals("", pending.draft)
        assertEquals("Ship it", pending.messages().first().text)
        val body = takeSend()
        assertEquals("Ship it", body.getValue("text").jsonPrimitive.content)
        assertFalse("model" in body)

        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":true}""")
        viewModel.uiState.first { it.liveCard() != null }
        gateway.addRow(BELLA_KEY, "user", "Ship it", clientMessageId = body.clientMessageId())
        gateway.addRow(BELLA_KEY, "assistant", "Shipped.")
        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":false}""")
        gateway.push("changed", """{"conversationKey":"$BELLA_KEY","revision":3,"rewriteRevision":0}""")

        val stored = viewModel.uiState.first { it.messages().size == 3 && it.liveCard() == null }
        assertEquals(listOf("Shipped.", "Ship it", "Hi"), stored.messages().map { it.text })
        assertEquals(setOf(SendState.STORED), stored.messages().map { it.sendState }.toSet())
    }

    @Test
    fun `a reply's live card shows its steps as they run and end, and stays the same card above the reply`() = runTest {
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.isReadyToSend && it.isStreamOpen }
        val startedAt = FakeGateway.CREATED_AT + 60_000

        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":true}""")
        val typing = checkNotNull(viewModel.uiState.first { it.liveCard() != null }.liveCard())
        assertEquals(emptyList<ActivityRow>(), typing.rows)

        gateway.push(
            "step",
            """{"conversationKey":"$BELLA_KEY","stepId":"s1","tool":"web-search","label":"Web search","detail":"OVH invoice terms","state":"started","startedAt":$startedAt}""",
        )
        val running = checkNotNull(viewModel.uiState.first { it.liveCard()?.rows.orEmpty().isNotEmpty() }.liveCard())
        assertEquals(typing.key, running.key)
        assertEquals(listOf(ActivityRow.Step(ActivityStep("web-search", "Web search", "OVH invoice terms", Instant.ofEpochMilli(startedAt), null))), running.rows)

        gateway.push(
            "step",
            """{"conversationKey":"$BELLA_KEY","stepId":"s1","tool":"web-search","label":"Web search","detail":"OVH invoice terms","state":"completed","startedAt":$startedAt,"durationMs":2100}""",
        )
        val done = checkNotNull(viewModel.uiState.first { it.liveCard()?.rows?.size == 2 }.liveCard())
        assertEquals(
            listOf(ActivityRow.Step(ActivityStep("web-search", "Web search", "OVH invoice terms", Instant.ofEpochMilli(startedAt), 2100)), ActivityRow.Thinking),
            done.rows,
        )

        // Typing ends before the reply lands; the card waits for it, then shows above it under the same key.
        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":false}""")
        val ended = checkNotNull(viewModel.uiState.first { it.liveCard()?.rows?.size == 1 }.liveCard())
        assertEquals(typing.key, ended.key)
        gateway.addRow(
            BELLA_KEY,
            "assistant",
            "Due Nov 28.",
            steps = """[{"tool":"web-search","label":"Web search","detail":"OVH invoice terms","startedAt":$startedAt,"durationMs":2100,"failed":false}]""",
        )
        gateway.push("changed", """{"conversationKey":"$BELLA_KEY","revision":1,"rewriteRevision":0}""")
        val replied = viewModel.uiState.first { it.messages().isNotEmpty() }
        assertNull(replied.liveCard())
        assertEquals(listOf("message-${replied.messages().single().id}", typing.key), replied.rows.take(2).map { it.key })
    }

    @Test
    fun `a reconnect mid-turn keeps the live card and its steps while the turn replays`() = runTest {
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.isReadyToSend && it.isStreamOpen }
        val startedAt = FakeGateway.CREATED_AT + 60_000
        val step = """{"conversationKey":"$BELLA_KEY","stepId":"s1","tool":"web-search","label":"Web search","detail":"OVH invoice terms","state":"completed","startedAt":$startedAt,"durationMs":2100}"""
        val searched = ActivityRow.Step(ActivityStep("web-search", "Web search", "OVH invoice terms", Instant.ofEpochMilli(startedAt), 2100))

        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":true}""")
        gateway.push("step", step)
        val before = checkNotNull(viewModel.uiState.first { it.liveCard()?.rows?.size == 2 }.liveCard())

        // A new stream opens with check, which ends typing; the card keeps its step meanwhile.
        gateway.push("check", "{}")
        val checked = checkNotNull(viewModel.uiState.first { it.liveCard()?.rows?.size == 1 }.liveCard())
        assertEquals(before.key, checked.key)
        assertEquals(listOf(searched), checked.rows)

        // The gateway replays the running turn: the same card types again.
        gateway.push("typing", """{"conversationKey":"$BELLA_KEY","typing":true}""")
        gateway.push("step", step)
        val replayed = checkNotNull(viewModel.uiState.first { it.liveCard()?.rows?.size == 2 }.liveCard())
        assertEquals(before.key, replayed.key)
        assertEquals(listOf(searched, ActivityRow.Thinking), replayed.rows)
    }

    @Test
    fun `a reply shows the steps history gives it, the pause between them and how long they took`() = runTest {
        val startedAt = FakeGateway.CREATED_AT
        gateway.addRow(
            BELLA_KEY,
            "assistant",
            "Due Nov 28.",
            steps = """[
                {"tool":"delegate-memory","label":"Delegate memory","detail":"Find the OVH billing day","startedAt":$startedAt,"durationMs":500,"failed":false},
                {"tool":"web-search","label":"Web search","detail":"","startedAt":${startedAt + 2500},"durationMs":300,"failed":true}
            ]""",
        )
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())

        val row = viewModel.uiState.first { it.rows.isNotEmpty() }.rows.filterIsInstance<ChatRow.Activity>().single()

        assertEquals(
            listOf(
                ActivityRow.Step(ActivityStep("delegate-memory", "Delegate memory", "Find the OVH billing day", Instant.ofEpochMilli(startedAt), 500)),
                ActivityRow.Thought(2),
                ActivityRow.Step(ActivityStep("web-search", "Web search", "", Instant.ofEpochMilli(startedAt + 2500), 300, failed = true)),
            ),
            row.rows,
        )
        // The steps ran 2.8 s, from the first start to the last end.
        assertEquals(3L, row.seconds)
    }

    @Test
    fun `a refused send shows the server's text and a retry sends it again with the same id`() = runTest {
        gateway.sendFailures.put(400 to errorAnswer("The provider has no API key"))
        val viewModel = kotlinChat(repository())

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
        viewModel.uiState.first { it.isReadyToSend && it.isStreamOpen }

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
        awaitTrue("the failing history read is answered") { gateway.historyFailures.isEmpty() }

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
        viewModel.uiState.first { it.title == "Kotlin" && it.isStreamOpen }

        gateway.deleteChat("plain:ada:k1")
        gateway.push("deleted", """{"conversationKey":"plain:ada:k1"}""")

        viewModel.uiState.first { it.isMissing }
    }

    @Test
    fun `a reply shows once and stays when a removed row reloads the history`() = runTest {
        val removed = gateway.addRow(BELLA_KEY, "user", "Hello")
        gateway.addRow(BELLA_KEY, "assistant", "Kept")
        val viewModel = viewModel(BELLACLAW_CHAT_ID, repository())
        viewModel.uiState.first { it.messages().size == 2 && it.isStreamOpen }

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

    private fun ModelPickerState?.loaded() = (this?.providers as? Loadable.Loaded)?.value

    /** Opens the model picker and waits for its list. */
    private suspend fun ChatViewModel.openedPicker(): ModelPickerState {
        openModelPicker()
        return checkNotNull(uiState.first { it.picker.loaded() != null }.picker)
    }

    @Test
    fun `the picker lists every provider's models, and the pick is kept on the phone and goes with the chat's sends`() = runTest {
        testServer.route("GET", "/api/models", 200, chatModelsAnswer(codexReason = null))
        val repository = repository()
        val viewModel = kotlinChat(repository)

        val opened = viewModel.openedPicker()
        assertEquals(listOf("opencode-go", "openai-codex"), opened.loaded()?.map { it.id })
        assertEquals(listOf("Kimi K3.1 Pro", "GLM 5"), opened.loaded()?.first()?.models?.map { it.name })
        assertEquals(ModelChoice("opencode-go", "kimi-k3.1-pro", Effort.MEDIUM), opened.selection)
        // Another provider's model keeps the effort it supports; GLM 5 has no medium, so its first.
        viewModel.onPickerModel("openai-codex", "gpt-5.5")
        assertEquals(Effort.MEDIUM, viewModel.uiState.first { it.picker?.selection?.model == "gpt-5.5" }.picker?.selection?.effort)
        viewModel.onPickerModel("opencode-go", "glm-5")
        val glm = viewModel.uiState.first { it.picker?.selection?.model == "glm-5" }.picker!!
        assertEquals(Effort.LOW, glm.selection?.effort)
        assertEquals(listOf(Effort.LOW, Effort.HIGH), glm.efforts)
        viewModel.onPickerEffort(Effort.HIGH)
        viewModel.confirmModelPicker()
        val picked = ModelChoice("opencode-go", "glm-5", Effort.HIGH)
        // Stored once the chat shows it.
        repository.chat("plain:ada:k1").first { (it as? PlainChat)?.model == picked }

        val restarted = viewModel("plain:ada:k1", repository())
        restarted.uiState.first { it.title == "Kotlin" }
        assertEquals(picked, restarted.openedPicker().selection)
        restarted.dismissModelPicker()
        restarted.onDraftChange("Hi")
        restarted.send()
        assertEquals("""{"provider":"opencode-go","model":"glm-5","effort":"high"}""", takeSend().getValue("model").toString())
    }

    @Test
    fun `a chat with no pick starts with the model used last on this phone`() = runTest {
        gateway.addChat("plain:ada:k2", "Rust")
        val repository = repository()
        val first = kotlinChat(repository)
        first.openedPicker()
        first.onPickerModel("opencode-go", "glm-5")
        first.confirmModelPicker()
        repository.chat("plain:ada:k1").first { (it as? PlainChat)?.model?.model == "glm-5" }

        val second = viewModel("plain:ada:k2", repository)
        second.uiState.first { it.title == "Rust" && it.isReadyToSend }
        second.onDraftChange("Hi")
        second.send()

        assertEquals("""{"provider":"opencode-go","model":"glm-5","effort":"low"}""", takeSend().getValue("model").toString())
    }

    @Test
    fun `a pick the list no longer allows stays on the chat, and the picker starts from a valid choice`() = runTest {
        testServer.route("GET", "/api/models", 200, chatModelsAnswer(codexReason = null))
        val repository = repository()
        val viewModel = kotlinChat(repository)
        viewModel.openedPicker()
        viewModel.onPickerModel("openai-codex", "gpt-5.5")
        viewModel.onPickerEffort(Effort.XHIGH)
        viewModel.confirmModelPicker()
        val codex = ModelChoice("openai-codex", "gpt-5.5", Effort.XHIGH)
        repository.chat("plain:ada:k1").first { (it as? PlainChat)?.model == codex }
        viewModel.uiState.first { it.picker == null }

        testServer.route("GET", "/api/models", 200, chatModelsAnswer())
        viewModel.openModelPicker()

        // Codex is no longer connected, so the picker leaves it out.
        val reopened = viewModel.uiState.first { state -> state.picker.loaded()?.map { it.id } == listOf("opencode-go") }.picker!!
        assertEquals(ModelChoice("opencode-go", "kimi-k3.1-pro", Effort.MEDIUM), reopened.selection)
        viewModel.dismissModelPicker()
        viewModel.uiState.first { it.picker == null }
        assertEquals(codex, (repository.chat("plain:ada:k1").first() as PlainChat).model)
    }

    @Test
    fun `the picker shows the list it holds at once while reading it again`() = runTest {
        val store = testServer.signedInStore()
        val settings = testServer.settingsRepository(store, backgroundScope)
        val viewModel = kotlinChat(testServer.chatRepository(store, backgroundScope, settings = settings), settings)
        settings.settings.first { it.chatModels is Loadable.Loaded }
        val hold = CompletableDeferred<Unit>()
        testServer.route("GET", "/api/models", 200, chatModelsAnswer(codexReason = null), until = hold)

        viewModel.openModelPicker()

        val held = viewModel.uiState.first { it.picker != null }.picker
        assertEquals(listOf("opencode-go"), held.loaded()?.map { it.id })
        hold.complete(Unit)
        viewModel.uiState.first { it.picker.loaded()?.map { provider -> provider.id } == listOf("opencode-go", "openai-codex") }
    }

    @Test
    fun `a failed read of the list shows in the picker until Retry reads it`() = runTest {
        testServer.route("GET", "/api/models", 503, errorAnswer("Unavailable"))
        val viewModel = kotlinChat(repository())

        viewModel.openModelPicker()

        val failed = viewModel.uiState.first { it.picker?.providers is Loadable.Failed }.picker
        assertNull(failed?.selection)
        testServer.route("GET", "/api/models", 200, chatModelsAnswer())
        viewModel.retryModelPicker()
        val loaded = viewModel.uiState.first { it.picker.loaded() != null }.picker
        assertEquals(ModelChoice("opencode-go", "kimi-k3.1-pro", Effort.MEDIUM), loaded?.selection)
    }

    @Test
    fun `a plain chat waits for the account's models, read again when the chat or picker opens, then sends Main's model at an effort it supports`() = runTest {
        gateway.addChat("plain:ada:k1", "Kotlin")
        testServer.route("GET", "/api/model", 503, errorAnswer("Unavailable"))
        val store = testServer.signedInStore()
        val settings = testServer.settingsRepository(store, backgroundScope)
        settings.settings.first { it.models is Loadable.Failed }
        val viewModel = viewModel("plain:ada:k1", testServer.chatRepository(store, backgroundScope, settings = settings), settings = settings)
        // The read at sign-in and the one the chat's opening started.
        withContext(Dispatchers.IO) {
            testServer.takeRequest("GET", "/api/model")
            testServer.takeRequest("GET", "/api/model")
        }
        settings.settings.first { it.models is Loadable.Failed }
        viewModel.uiState.first { it.title == "Kotlin" }
        viewModel.onDraftChange("Hello")

        viewModel.send()

        assertFalse(viewModel.uiState.first { it.draft == "Hello" }.canSend)

        // GLM 5 lists low and high, no medium.
        testServer.route("GET", "/api/model", 200, modelAnswer(mainModel = "glm-5"))
        viewModel.openModelPicker()
        viewModel.uiState.first { it.canSend }
        viewModel.dismissModelPicker()
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
        restored.uiState.first { it.isReadyToSend && it.draft == "   " }
        restored.send()
        restored.onDraftChange("Hello")
        restored.uiState.first { it.canSend }
        restored.send()
        assertEquals("Hello", takeSend().getValue("text").jsonPrimitive.content)
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
