package one.scary.bellaclaw.ui.chat

import androidx.lifecycle.SavedStateHandle
import kotlin.time.Duration
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.FakeGateway
import one.scary.bellaclaw.data.FakeGateway.Companion.BELLA_KEY
import one.scary.bellaclaw.data.LISTS_NOW
import one.scary.bellaclaw.data.ListsRepository
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.listAnswer
import one.scary.bellaclaw.data.listsAnswer
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.FinishedList
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class ChatListsTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val testServer = TestServer()

    private lateinit var gateway: FakeGateway
    private val now = MutableStateFlow(LISTS_NOW)
    private val hour = 3_600_000L

    @Before
    fun setUp() {
        gateway = testServer.gateway()
    }

    private suspend fun TestScope.viewModel(chatId: String = BELLACLAW_CHAT_ID): Pair<ChatViewModel, ListsRepository> {
        val store = testServer.signedInStore()
        val lists = testServer.listsRepository(store, backgroundScope, now)
        val chats = testServer.chatRepository(store, backgroundScope, onListsChanged = lists::refresh)
        val viewModel = ChatViewModel(
            chatId,
            chats,
            testServer.settingsRepository(scope = backgroundScope),
            lists,
            SavedStateHandle(),
            ZoneOffset.UTC,
            Duration.INFINITE,
        )
        collectIn(viewModel.uiState)
        return viewModel to lists
    }

    @Test
    fun thePillShowsTheListThatEndsFirst() = runTest {
        val at = FakeGateway.CREATED_AT
        gateway.lists = listsAnswer(
            listAnswer("never", "No end", listOf("i2" to ("Bread" to false))),
            listAnswer("later", "Later", listOf("i3" to ("Eggs" to false)), expiresAt = at + 2 * hour),
            listAnswer("done", "Done", listOf("i1" to ("Milk" to true)), expiresAt = at + hour),
            listAnswer("ended", "Ended", listOf("i4" to ("Tea" to false)), expiresAt = at),
        )
        val (viewModel) = viewModel()

        val state = viewModel.uiState.first { it.lists.isNotEmpty() }

        assertEquals(listOf("done", "later", "never"), state.lists.map { it.id })
    }

    @Test
    fun aFinishedListWithoutAnEndLeavesAnHourAfterItsLastChange() = runTest {
        gateway.lists = listsAnswer(listAnswer("l1", "Shopping", listOf("i1" to ("Milk" to true))))
        val (viewModel) = viewModel()
        viewModel.uiState.first { it.lists.isNotEmpty() }

        now.value = Instant.ofEpochMilli(FakeGateway.CREATED_AT + hour)

        assertEquals(emptyList<Any>(), viewModel.uiState.first { it.lists.isEmpty() }.lists)
    }

    @Test
    fun aSwipedListStaysAwayUntilItChanges() = runTest {
        gateway.lists = listsAnswer(listAnswer("l1", "Shopping", listOf("i1" to ("Milk" to true))))
        val (viewModel) = viewModel()
        val finished = viewModel.uiState.first { it.lists.isNotEmpty() }.lists.single()

        viewModel.dismissList(finished)
        viewModel.uiState.first { it.lists.isEmpty() }

        gateway.lists = listsAnswer(
            listAnswer("l1", "Shopping", listOf("i1" to ("Milk" to true), "i2" to ("Bread" to false)), updatedAt = FakeGateway.CREATED_AT + 1),
        )
        gateway.push("lists", "{}")
        assertEquals(2, viewModel.uiState.first { it.lists.isNotEmpty() }.lists.single().items.size)
    }

    @Test
    fun aPlainChatShowsNoLists() = runTest {
        gateway.lists = listsAnswer(listAnswer("l1", "Shopping", listOf("i1" to ("Milk" to false))))
        gateway.addChat("plain:ada:k1", "Kotlin")
        val (viewModel, lists) = viewModel("plain:ada:k1")
        lists.lists.first { !it.isNullOrEmpty() }

        assertEquals(emptyList<Any>(), viewModel.uiState.first { it.title == "Kotlin" }.lists)
    }

    @Test
    fun aFinishedListRowCarriesTheList() = runTest {
        gateway.addRow(BELLA_KEY, "assistant", "Shopping · 3/3 finished", listFinished = """{"name":"Shopping","total":3}""")
        val (viewModel) = viewModel()

        val row = viewModel.uiState.first { it.rows.any { row -> row is ChatRow.Item } }.rows.filterIsInstance<ChatRow.Item>().single()

        assertEquals(FinishedList("Shopping", 3), row.message.finishedList)
    }
}
