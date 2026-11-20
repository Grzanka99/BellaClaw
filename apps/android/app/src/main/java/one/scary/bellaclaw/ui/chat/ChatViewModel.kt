package one.scary.bellaclaw.ui.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.toRoute
import kotlinx.coroutines.Job
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
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.BellaClawChat
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.ChatProvider
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ImageCheck
import one.scary.bellaclaw.model.ImageRefusal
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PickedImage
import one.scary.bellaclaw.model.PlainChat
import one.scary.bellaclaw.ui.appContainer
import one.scary.bellaclaw.ui.navigation.ChatDestination
import java.io.File
import java.time.ZoneId

class ChatViewModel(
    private val chatId: String,
    private val chatRepository: ChatRepository,
    private val settingsRepository: SettingsRepository,
    savedStateHandle: SavedStateHandle,
    private val zone: ZoneId = ZoneId.systemDefault(),
) : ViewModel() {
    /**
     * What only this screen knows besides the draft: the picked image or why the last pick was refused,
     * whether a pick is being checked, the image open full screen, whether the picker is open and
     * its selection as last set; the picker shows it made valid for the model list.
     */
    private data class LocalState(
        val attachment: PickedImage? = null,
        val attachmentRefusal: ImageRefusal? = null,
        /** The picked image being checked, shown meanwhile so it can be removed. */
        val checkingUri: String? = null,
        val viewedImage: MessageImage? = null,
        val isPickerOpen: Boolean = false,
        val pickerSelection: ModelChoice? = null,
    )

    /** The composer's text, kept in [savedStateHandle] across process death. */
    private val draft = savedStateHandle.getMutableStateFlow(DRAFT_KEY, "")
    private val local = MutableStateFlow(LocalState())

    /** The check of the latest pick, cancelled when another pick replaces it or the image is removed. */
    private var attachmentCheck: Job? = null

    init {
        if (chatId != BELLACLAW_CHAT_ID) {
            settingsRepository.reloadChatModels(refresh = false)
        }
    }

    private val chatState = combine(
        chatRepository.chat(chatId),
        chatRepository.messages(chatId),
        chatRepository.isTyping(chatId),
        chatRepository.isStreamOpen,
        chatRepository.canSend(chatId),
    ) { chat, messages, typing, streamOpen, isReadyToSend ->
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
            isReadyToSend = isReadyToSend,
        )
    }

    val uiState: StateFlow<ChatUiState> = combine(
        chatState,
        draft,
        local,
        settingsRepository.settings,
    ) { chat, draft, local, settings ->
        val picker = if (local.isPickerOpen) {
            val usable = settings.chatModels.map { providers -> providers.filter { it.isUsable } }
            ModelPickerState(usable, validSelection(local.pickerSelection, settings.chatModels))
        } else {
            null
        }
        chat.copy(
            draft = draft,
            attachmentUri = local.checkingUri ?: local.attachment?.uri,
            attachmentRefusal = local.attachmentRefusal,
            isCheckingAttachment = local.checkingUri != null,
            viewedImage = local.viewedImage,
            picker = picker,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ChatUiState())

    fun onDraftChange(text: String) {
        draft.value = text
    }

    /**
     * Attaches the picked image at [uri] if the server takes it; otherwise keeps what was attached and says why
     * not. Nothing is sent while it is checked.
     */
    fun onAttach(uri: String) {
        attachmentCheck?.cancel()
        local.update { it.copy(checkingUri = uri) }
        attachmentCheck = viewModelScope.launch {
            when (val check = chatRepository.checkImage(uri)) {
                is ImageCheck.Ready -> local.update {
                    it.copy(attachment = check.image, attachmentRefusal = null, checkingUri = null)
                }
                is ImageCheck.Refused -> local.update { it.copy(attachmentRefusal = check.reason, checkingUri = null) }
            }
        }
    }

    fun onRemoveAttachment() {
        attachmentCheck?.cancel()
        local.update { it.copy(attachment = null, attachmentRefusal = null, checkingUri = null) }
    }

    /** Sends the draft's text and the attached image; one of them is enough. */
    fun send() {
        val text = draft.value
        val image = local.value.attachment
        if (local.value.checkingUri != null || (text.isBlank() && image == null)) {
            return
        }
        if (chatRepository.send(chatId, text.trim(), image)) {
            draft.value = ""
            local.update { it.copy(attachment = null, attachmentRefusal = null) }
        }
    }

    /** The image [mediaId] of this chat as a file on the phone, or null when there is none to show now. */
    suspend fun imageFile(mediaId: String): File? = chatRepository.imageFile(chatId, mediaId)

    fun openImage(image: MessageImage) {
        local.update { it.copy(viewedImage = image) }
    }

    fun closeImage() {
        local.update { it.copy(viewedImage = null) }
    }

    /** Sends the failed message [messageId] again. */
    fun retry(messageId: String) {
        chatRepository.retry(chatId, messageId)
    }

    /** The reader reached the oldest loaded row. */
    fun loadOlder() {
        chatRepository.loadOlder(chatId)
    }

    /** Opens the picker on the chat's model and reads the model list again, and the account's models if they failed. */
    fun openModelPicker() {
        settingsRepository.reloadChatModels(refresh = true)
        viewModelScope.launch {
            val chat = chatRepository.chat(chatId).first()
            if (chat is PlainChat) {
                local.update { it.copy(isPickerOpen = true, pickerSelection = chat.model) }
            }
        }
    }

    /** Reads the model list again after it failed. */
    fun retryModelPicker() {
        settingsRepository.reloadChatModels(refresh = true)
    }

    /** Picks [model] of [providerId]; the effort stays if the model supports it. */
    fun onPickerModel(providerId: String, model: String) {
        updatePicker { it.copy(providerId = providerId, model = model) }
    }

    fun onPickerEffort(effort: Effort) {
        updatePicker { it.copy(effort = effort) }
    }

    fun confirmModelPicker() {
        // With no provider connected there is nothing to store: Done just closes.
        val selection = validSelection(local.value.pickerSelection, settingsRepository.settings.value.chatModels)
        if (selection == null) {
            dismissModelPicker()
            return
        }
        viewModelScope.launch {
            chatRepository.setModel(chatId, selection)
            local.update { it.copy(isPickerOpen = false, pickerSelection = null) }
        }
    }

    fun dismissModelPicker() {
        local.update { it.copy(isPickerOpen = false, pickerSelection = null) }
    }

    /** Changes the selection the picker shows. */
    private fun updatePicker(change: (ModelChoice) -> ModelChoice) {
        val chatModels = settingsRepository.settings.value.chatModels
        local.update { state -> state.copy(pickerSelection = validSelection(state.pickerSelection, chatModels)?.let(change)) }
    }

    private fun validSelection(selection: ModelChoice?, chatModels: Loadable<List<ChatProvider>>): ModelChoice? =
        chatModels.valueOrNull?.let { pickerSelection(selection, it) }

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
