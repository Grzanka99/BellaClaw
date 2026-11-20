package one.scary.bellaclaw.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.model.BellaClawChat
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.ui.appContainer

class HomeViewModel(private val chatRepository: ChatRepository) : ViewModel() {
    val uiState: StateFlow<HomeUiState> = combine(
        chatRepository.chats,
        chatRepository.latestMessages,
        chatRepository.unread,
    ) { chats, latest, unread ->
        val bellaClaw = latest[BellaClawChat.id]
        HomeUiState(
            bellaClaw = BellaClawSummary(BellaClawChat.id, bellaClaw?.text, bellaClaw?.sentAt, BellaClawChat.id in unread),
            // The repository's order: the latest active first. A chat with no message yet is left out.
            chats = chats
                .filterIsInstance<PlainChat>()
                .mapNotNull { chat ->
                    val last = latest[chat.id] ?: return@mapNotNull null
                    PlainChatSummary(chat.id, chat.title, chat.icon, last.text, last.sentAt, chat.id in unread)
                },
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeUiState())

    companion object {
        val Factory = viewModelFactory {
            initializer { HomeViewModel(appContainer().chatRepository) }
        }
    }
}
