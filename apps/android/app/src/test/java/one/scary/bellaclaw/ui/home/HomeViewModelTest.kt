package one.scary.bellaclaw.ui.home

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.FakeGateway
import one.scary.bellaclaw.data.FakeGateway.Companion.BELLA_KEY
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.chat.ChatRow
import one.scary.bellaclaw.ui.chat.ChatViewModel
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class HomeViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val testServer = TestServer()

    private lateinit var gateway: FakeGateway

    @Before
    fun setUp() {
        gateway = testServer.gateway()
    }

    private fun TestScope.home(repository: ChatRepository) = HomeViewModel(repository).also { collectIn(it.uiState) }

    private suspend fun TestScope.repository(store: SessionStore? = null) =
        testServer.chatRepository(store ?: testServer.signedInStore(), backgroundScope)

    @Test
    fun `lists BellaClaw apart from the plain chats, the latest active first`() = runTest {
        gateway.addChat("plain:ada:a", "Regex")
        gateway.addChat("plain:ada:b")
        gateway.addRow("plain:ada:b", "user", "Hello")
        gateway.addRow("plain:ada:a", "assistant", "^\\d{2}-\\d{3}$")
        gateway.addRow(BELLA_KEY, "assistant", "Reminder set for 18:00.")
        val viewModel = home(repository())

        val state = viewModel.uiState.first { it.chats.size == 2 }

        assertEquals(BELLACLAW_CHAT_ID, state.bellaClaw.id)
        assertEquals("Reminder set for 18:00.", state.bellaClaw.preview)
        assertEquals(listOf("plain:ada:a", "plain:ada:b"), state.chats.map { it.id })
        assertEquals(listOf("Regex", null), state.chats.map { it.title })
        assertEquals("^\\d{2}-\\d{3}$", state.chats[0].preview)
        assertEquals("Hello", state.chats[1].preview)
    }

    @Test
    fun `a chat is unread until its screen shows the newest row`() = runTest {
        gateway.addRow(BELLA_KEY, "assistant", "Reminder set for 18:00.")
        val repository = repository()
        val viewModel = home(repository)
        viewModel.uiState.first { it.bellaClaw.isUnread == true }

        val chat = ChatViewModel(BELLACLAW_CHAT_ID, repository, testServer.settingsRepository(scope = backgroundScope), testServer.listsRepository(testServer.store(), backgroundScope), SavedStateHandle())
        collectIn(chat.uiState)
        chat.uiState.first { state -> state.rows.any { it is ChatRow.Item } }

        viewModel.uiState.first { it.bellaClaw.isUnread == false }
    }

    @Test
    fun `an empty plain chat is not listed, and is listed once it has a message`() = runTest {
        gateway.addChat("plain:ada:a")
        gateway.addChat("plain:ada:b", "Regex")
        gateway.addRow("plain:ada:b", "user", "Match a postcode")
        val repository = repository()
        val viewModel = home(repository)

        val populated = viewModel.uiState.first { state -> state.chats.any { it.id == "plain:ada:b" } }
        assertEquals(listOf("plain:ada:b"), populated.chats.map { it.id })

        val created = "plain:ada:a"
        val chat = ChatViewModel(created, repository, testServer.settingsRepository(scope = backgroundScope), testServer.listsRepository(testServer.store(), backgroundScope), SavedStateHandle())
        collectIn(chat.uiState)
        chat.uiState.first { it.isReadyToSend }

        chat.onDraftChange("Hello")
        chat.send()

        val listed = viewModel.uiState.first { state -> state.chats.any { it.id == created } }
        assertEquals("Hello", listed.chats.single { it.id == created }.preview)
    }

    @Test
    fun `signing out leaves no chat behind, and signing in loads them again`() = runTest {
        gateway.addChat("plain:ada:a", "Regex")
        gateway.addRow("plain:ada:a", "user", "Match a postcode")
        gateway.addRow(BELLA_KEY, "assistant", "Reminder set for 18:00.")
        val store = testServer.signedInStore()
        val viewModel = home(repository(store))
        viewModel.uiState.first { it.chats.size == 1 && it.bellaClaw.preview != null }

        testServer.repository(store).signOut()

        viewModel.uiState.first { it.chats.isEmpty() && it.bellaClaw.preview == null }

        store.save(Session(testServer.url, "ada", "t1"))
        viewModel.uiState.first { it.chats.size == 1 && it.bellaClaw.preview != null }
    }
}
