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
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.Personality
import one.scary.bellaclaw.ui.appContainer

/** Edits a draft of the personality, kept in [savedStateHandle] across process death; nothing is stored until [save]. */
class PersonalityViewModel(
    private val settingsRepository: SettingsRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private data class Save(val isRunning: Boolean = false, val error: AccountError? = null, val isDone: Boolean = false)

    private val draft = savedStateHandle.getMutableStateFlow<Personality?>(DRAFT_KEY, null)
    private val save = MutableStateFlow(Save())

    val uiState: StateFlow<PersonalityUiState> = combine(settingsRepository.settings, draft, save) { settings, draft, save ->
        when (val loaded = settings.personality) {
            Loadable.Loading -> PersonalityUiState(isLoading = true)
            is Loadable.Failed -> PersonalityUiState(isLoading = false, loadError = loaded.error)
            is Loadable.Loaded -> {
                val saved = loaded.value
                val shown = draft ?: saved
                PersonalityUiState(
                    isLoading = false,
                    bellaClaw = shown.bellaClaw,
                    useInChats = shown.useInChats,
                    chats = shown.chats,
                    canSave = draft != null && draft != saved && !save.isRunning,
                    isSaving = save.isRunning,
                    saveError = save.error,
                    isSaved = save.isDone,
                )
            }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PersonalityUiState())

    fun retry() {
        viewModelScope.launch {
            settingsRepository.loadPersonality()
        }
    }

    fun onBellaClawChange(text: String) {
        edit { it.copy(bellaClaw = text) }
    }

    fun onUseInChatsChange(enabled: Boolean) {
        edit { it.copy(useInChats = enabled) }
    }

    fun onChatsChange(text: String) {
        edit { it.copy(chats = text) }
    }

    /** A refusal keeps the draft and shows why. */
    fun save() {
        val edited = draft.value ?: return
        if (save.value.isRunning) {
            return
        }
        save.value = Save(isRunning = true)
        viewModelScope.launch {
            val error = settingsRepository.savePersonality(edited)
            if (error == null) {
                draft.value = null
                save.value = Save(isDone = true)
            } else {
                save.value = Save(error = error)
            }
        }
    }

    /** The screen acted on [PersonalityUiState.isSaved]. */
    fun onSaveHandled() {
        save.value = Save()
    }

    /**
     * Edits start from the loaded personality; there is nothing to edit before it arrives. None is
     * taken while a save runs or after it succeeded, until the screen closes.
     */
    private fun edit(change: (Personality) -> Personality) {
        if (save.value.isRunning || save.value.isDone) {
            return
        }
        val base = draft.value ?: settingsRepository.settings.value.personality.valueOrNull ?: return
        draft.value = change(base)
    }

    companion object {
        private const val DRAFT_KEY = "personalityDraft"

        val Factory = viewModelFactory {
            initializer { PersonalityViewModel(appContainer().settingsRepository, createSavedStateHandle()) }
        }
    }
}
