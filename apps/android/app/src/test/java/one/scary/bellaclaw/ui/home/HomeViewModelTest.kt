package one.scary.bellaclaw.ui.home

import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class HomeViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `lists BellaClaw apart from the plain chats, newest chat first`() = runTest {
        val viewModel = HomeViewModel(ChatRepository(backgroundScope))
        collectIn(viewModel.uiState)

        val state = viewModel.uiState.value
        assertEquals(BELLACLAW_CHAT_ID, state.bellaClaw?.id)
        assertEquals("Reminder set for 18:00.", state.bellaClaw?.preview)
        assertFalse(state.chats.any { it.id == BELLACLAW_CHAT_ID })
        assertEquals("kotlin-flow", state.chats.first().id)
        val times = state.chats.mapNotNull { it.lastActivity }
        assertEquals(times.sortedDescending(), times)
    }

    @Test
    fun `new chat is created untitled and handed to the screen once`() = runTest {
        val viewModel = HomeViewModel(ChatRepository(backgroundScope))
        collectIn(viewModel.uiState)
        val before = viewModel.uiState.value.chats.size

        viewModel.newChat()

        val created = viewModel.uiState.value.createdChatId
        assertNotNull(created)
        val chat = viewModel.uiState.value.chats.single { it.id == created }
        assertNull(chat.title)
        assertEquals(before + 1, viewModel.uiState.value.chats.size)

        viewModel.onNewChatOpened()
        assertNull(viewModel.uiState.value.createdChatId)
    }

    @Test
    fun `repeated new chat taps create one chat, kept pending until it is opened`() = runTest {
        val viewModel = HomeViewModel(ChatRepository(backgroundScope))
        collectIn(viewModel.uiState)
        val before = viewModel.uiState.value.chats.size

        viewModel.newChat()
        val created = viewModel.uiState.value.createdChatId
        viewModel.newChat()
        assertEquals(before + 1, viewModel.uiState.value.chats.size)
        assertEquals(created, viewModel.uiState.value.createdChatId)

        viewModel.onNewChatOpened()
        viewModel.newChat()
        assertEquals(before + 2, viewModel.uiState.value.chats.size)
    }
}
