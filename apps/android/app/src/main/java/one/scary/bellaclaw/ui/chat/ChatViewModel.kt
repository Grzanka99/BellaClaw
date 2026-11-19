package one.scary.bellaclaw.ui.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.toRoute
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.BellaClawChat
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.ui.appContainer
import one.scary.bellaclaw.ui.navigation.ChatDestination
import java.time.ZoneId

class ChatViewModel(
    private val chatId: String,
    private val chatRepository: ChatRepository,
    private val settingsRepository: SettingsRepository,
    savedStateHandle: SavedStateHandle,
    private val zone: ZoneId = ZoneId.systemDefault(),
) : ViewModel() {
    /** What only this screen knows besides the draft: the picked image and the open picker's selection. */
    private data class LocalState(
        val attachmentUri: String? = null,
        val pickerSelection: ModelChoice? = null,
    )

    /** The composer's text, kept in [savedStateHandle] across process death. */
    private val draft = savedStateHandle.getMutableStateFlow(DRAFT_KEY, "")
    private val local = MutableStateFlow(LocalState())

    private val chatState = combine(
        chatRepository.chat(chatId),
        chatRepository.messages(chatId),
        chatRepository.isTyping(chatId),
        chatRepository.isStreamOpen,
    ) { chat, messages, typing, streamOpen ->
        val (kind, title) = when (chat) {
            null -> return@combine ChatUiState(isMissing = true)
            is BellaClawChat -> ChatKind.BELLACLAW to null
            is PlainChat -> ChatKind.PLAIN to chat.title
        }
        ChatUiState(
            kind = kind,
            title = title,
            rows = chatRows(messages, zone),
            isTyping = typing,
            isStreamOpen = streamOpen,
        )
    }

    val uiState: StateFlow<ChatUiState> = combine(
        chatState,
        draft,
        local,
        settingsRepository.settings,
    ) { chat, draft, local, settings ->
        val picker = local.pickerSelection?.let { selection ->
            settings.providers.firstOrNull { it.id == selection.providerId }?.let { provider ->
                ModelPickerState(settings.providers, provider, selection)
            }
        }
        chat.copy(draft = draft, attachmentUri = local.attachmentUri, picker = picker)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ChatUiState())

    fun onDraftChange(text: String) {
        draft.value = text
    }

    fun onAttach(uri: String) {
        local.update { it.copy(attachmentUri = uri) }
    }

    fun onRemoveAttachment() {
        local.update { it.copy(attachmentUri = null) }
    }

    fun send() {
        val text = draft.value
        val attachmentUri = local.value.attachmentUri
        if (text.isBlank() && attachmentUri == null) {
            return
        }
        draft.value = ""
        local.update { it.copy(attachmentUri = null) }
        viewModelScope.launch {
            chatRepository.send(chatId, text.trim(), attachmentUri)
        }
    }

    fun openModelPicker() {
        viewModelScope.launch {
            val chat = chatRepository.chat(chatId).first()
            if (chat is PlainChat) {
                local.update { it.copy(pickerSelection = chat.model) }
            }
        }
    }

    /** Switching to another provider selects its first model and keeps the effort; the current provider changes nothing. */
    fun onPickerProvider(providerId: String) {
        updatePicker { selection ->
            val provider = settingsRepository.settings.value.providers.firstOrNull { it.id == providerId }
            if (provider == null || provider.id == selection.providerId) {
                selection
            } else {
                selection.copy(providerId = provider.id, model = provider.models.first())
            }
        }
    }

    fun onPickerModel(model: String) {
        updatePicker { it.copy(model = model) }
    }

    fun onPickerEffort(effort: Effort) {
        updatePicker { it.copy(effort = effort) }
    }

    fun confirmModelPicker() {
        val selection = local.value.pickerSelection ?: return
        local.update { it.copy(pickerSelection = null) }
        viewModelScope.launch {
            chatRepository.setModel(chatId, selection)
        }
    }

    fun dismissModelPicker() {
        local.update { it.copy(pickerSelection = null) }
    }

    private fun updatePicker(change: (ModelChoice) -> ModelChoice) {
        local.update { state -> state.copy(pickerSelection = state.pickerSelection?.let(change)) }
    }

    companion object {
        private const val DRAFT_KEY = "draft"

        val Factory = viewModelFactory {
            initializer {
                val container = appContainer()
                val savedStateHandle = createSavedStateHandle()
                ChatViewModel(
                    chatId = savedStateHandle.toRoute<ChatDestination>().chatId,
                    chatRepository = container.chatRepository,
                    settingsRepository = container.settingsRepository,
                    savedStateHandle = savedStateHandle,
                )
            }
        }
    }
}
