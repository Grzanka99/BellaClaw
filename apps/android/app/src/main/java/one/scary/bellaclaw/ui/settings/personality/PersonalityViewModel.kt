package one.scary.bellaclaw.ui.settings.personality

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.Personality
import one.scary.bellaclaw.ui.appContainer

/** Edits a draft of the personality, kept in [savedStateHandle] across process death; nothing is stored until [save]. */
class PersonalityViewModel(
    private val settingsRepository: SettingsRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val draft = savedStateHandle.getMutableStateFlow<Personality?>(DRAFT_KEY, null)
    private val isSaved = MutableStateFlow(false)

    val uiState: StateFlow<PersonalityUiState> = combine(settingsRepository.settings, draft, isSaved) { settings, draft, isSaved ->
        val saved = settings.personality
        val shown = draft ?: saved
        PersonalityUiState(
            bellaClaw = shown.bellaClaw,
            useInChats = shown.useInChats,
            chats = shown.chats,
            canSave = draft != null && draft != saved,
            isSaved = isSaved,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PersonalityUiState())

    fun onBellaClawChange(text: String) {
        edit { it.copy(bellaClaw = text) }
    }

    fun onUseInChatsChange(enabled: Boolean) {
        edit { it.copy(useInChats = enabled) }
    }

    fun onChatsChange(text: String) {
        edit { it.copy(chats = text) }
    }

    fun save() {
        val edited = draft.value ?: return
        viewModelScope.launch {
            settingsRepository.savePersonality(edited)
            draft.value = null
            isSaved.value = true
        }
    }

    /** The screen acted on [PersonalityUiState.isSaved]. */
    fun onSaveHandled() {
        isSaved.value = false
    }

    private fun edit(change: (Personality) -> Personality) {
        val base = draft.value ?: settingsRepository.settings.value.personality
        draft.value = change(base)
    }

    companion object {
        private const val DRAFT_KEY = "personalityDraft"

        val Factory = viewModelFactory {
            initializer { PersonalityViewModel(appContainer().settingsRepository, createSavedStateHandle()) }
        }
    }
}
