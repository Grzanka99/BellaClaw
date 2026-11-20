package one.scary.bellaclaw.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.model.BellaClawChat
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.ui.appContainer

class HomeViewModel(private val chatRepository: ChatRepository) : ViewModel() {
    private val createdChatId = MutableStateFlow<String?>(null)

    /** True from [newChat] until the screen has opened the new chat. */
    private var isCreatingChat = false

    val uiState: StateFlow<HomeUiState> = combine(
        chatRepository.chats,
        chatRepository.latestMessages,
        chatRepository.unread,
        createdChatId,
    ) { chats, latest, unread, created ->
        val bellaClaw = latest[BellaClawChat.id]
        HomeUiState(
            bellaClaw = BellaClawSummary(BellaClawChat.id, bellaClaw?.text, bellaClaw?.sentAt, BellaClawChat.id in unread),
            // The repository's order: the latest active first.
            chats = chats
                .filterIsInstance<PlainChat>()
                .map { chat ->
                    val last = latest[chat.id]
                    PlainChatSummary(chat.id, chat.title, chat.icon, last?.text, last?.sentAt, chat.id in unread)
                },
            createdChatId = created,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeUiState())

    /** Creates one chat; further calls do nothing until the screen reports it opened with [onNewChatOpened]. */
    fun newChat() {
        if (isCreatingChat) {
            return
        }
        isCreatingChat = true
        viewModelScope.launch {
            val created = chatRepository.createChat()
            if (created == null) {
                isCreatingChat = false
            } else {
                createdChatId.value = created
            }
        }
    }

    fun onNewChatOpened() {
        createdChatId.value = null
        isCreatingChat = false
    }

    companion object {
        val Factory = viewModelFactory {
            initializer { HomeViewModel(appContainer().chatRepository) }
        }
    }
}
