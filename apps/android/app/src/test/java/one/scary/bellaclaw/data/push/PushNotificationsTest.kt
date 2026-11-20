package one.scary.bellaclaw.data.push

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.FakeGateway
import one.scary.bellaclaw.data.FakeGateway.Companion.BELLA_KEY
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatNotification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class PushNotificationsTest {
    @get:Rule
    val testServer = TestServer()

    private lateinit var gateway: FakeGateway
    private val keys = newSoftwareKeys()
    private val foreground = MutableStateFlow(false)
    private val notifier = FakeNotifier()

    /** What shows now, by conversation key, and every show in order with whether it alerted. */
    private class FakeNotifier : Notifier {
        val showing = MutableStateFlow(emptyMap<String, ChatNotification>())
        val shows = mutableListOf<Pair<ChatNotification, Boolean>>()

        override fun show(notification: ChatNotification, alert: Boolean) {
            shows += notification to alert
            showing.update { it + (notification.conversationKey to notification) }
        }

        override fun cancel(conversationKey: String) {
            showing.update { it - conversationKey }
        }

        override fun cancelAll() {
            showing.value = emptyMap()
        }
    }

    private object NoTokens : PushTokens {
        override suspend fun token(): String? = null

        override suspend fun delete() {}
    }

    @Before
    fun setUp() {
        gateway = testServer.gateway()
    }

    /** The real chat and push repositories on [store], with notifications on [notifier], as the app wires them. */
    private fun TestScope.app(store: SessionStore): Pair<ChatRepository, PushRepository> {
        val chats = testServer.chatRepository(store, backgroundScope, foreground)
        val push = PushRepository(ApiClient(store), store.session, lazyOf(keys), NoTokens, Mutex(), backgroundScope)
        PushNotifications(push.pushes, chats, store.session, foreground, notifier, backgroundScope)
        return chats to push
    }

    /** Delivers a push of [key], of the Bella conversation's kind for [BELLA_KEY] and a plain chat's otherwise. */
    private suspend fun PushRepository.deliver(key: String, messageId: Long, text: String, truncated: Boolean = false) {
        val kind = if (key == BELLA_KEY) "bella" else "plain"
        val json = """{"conversationKey":"$key","kind":"$kind","messageId":$messageId,"revision":1,"text":"$text","truncated":$truncated}"""
        receive(encryptLikeServer(json, keys))
        awaitHandled()
    }

    @Test
    fun `a push in a fresh process shows at once with its chat, and its message is there when the chat opens`() = runTest {
        val (chats, push) = app(testServer.signedInStore())
        val id = gateway.addRow(BELLA_KEY, "assistant", "Reminder: call mum.")

        push.deliver(BELLA_KEY, id, "Reminder: call mum.")

        assertEquals(listOf(ChatNotification(BELLA_KEY, BELLACLAW_CHAT_ID, null, "Reminder: call mum.") to true), notifier.shows)
        assertEquals(listOf("Reminder: call mum."), chats.messages(BELLACLAW_CHAT_ID).first().map { it.text })
    }

    @Test
    fun `a cut push of a plain chat shows its start on that chat, then the whole message under its title`() = runTest {
        val (_, push) = app(testServer.signedInStore())
        gateway.addChat("plain:ada:a", "Recipes")
        val id = gateway.addRow("plain:ada:a", "assistant", "Whole recipe, every step.")

        push.deliver("plain:ada:a", id, "Whole rec", truncated = true)

        assertEquals(
            listOf(
                ChatNotification("plain:ada:a", "plain:ada:a", null, "Whole rec") to true,
                ChatNotification("plain:ada:a", "plain:ada:a", "Recipes", "Whole recipe, every step.") to false,
            ),
            notifier.shows,
        )
    }

    @Test
    fun `a chat on screen gets no notification, and opening a chat clears its own`() = runTest {
        val (chats, push) = app(testServer.signedInStore())
        val first = gateway.addRow(BELLA_KEY, "assistant", "First.")
        push.deliver(BELLA_KEY, first, "First.")
        assertTrue(BELLA_KEY in notifier.showing.value)

        foreground.value = true
        backgroundScope.launch { chats.messages(BELLACLAW_CHAT_ID).collect {} }
        notifier.showing.first { it.isEmpty() }

        val second = gateway.addRow(BELLA_KEY, "assistant", "Second.")
        val shows = notifier.shows.size
        push.deliver(BELLA_KEY, second, "Second.")
        assertEquals(shows, notifier.shows.size)
    }

    @Test
    fun `signing out clears every notification`() = runTest {
        val store = testServer.signedInStore()
        val (_, push) = app(store)
        gateway.addChat("plain:ada:a", "Recipes")
        push.deliver("plain:ada:a", gateway.addRow("plain:ada:a", "assistant", "Done."), "Done.")
        push.deliver(BELLA_KEY, gateway.addRow(BELLA_KEY, "assistant", "Hi."), "Hi.")
        assertEquals(2, notifier.showing.value.size)

        testServer.repository(store).signOut()

        notifier.showing.first { it.isEmpty() }
    }
}
