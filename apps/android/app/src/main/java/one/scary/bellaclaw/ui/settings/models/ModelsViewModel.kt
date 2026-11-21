package one.scary.bellaclaw.ui.settings.models

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.RoleModel
import one.scary.bellaclaw.ui.appContainer

/** Reads the models again when the screen opens; shows what the server answered, never what was asked for. */
class ModelsViewModel(private val settingsRepository: SettingsRepository) : ViewModel() {
    /** The open role sheet's unsaved choice; the sheet's model list comes from the settings. */
    private data class EditorDraft(val role: ModelRole, val model: RoleModel)

    private val editor = MutableStateFlow<EditorDraft?>(null)

    val uiState: StateFlow<ModelsUiState> = combine(settingsRepository.settings, editor) { settings, editor ->
        when (val loaded = settings.models) {
            Loadable.Loading -> ModelsUiState(isLoading = true)
            is Loadable.Failed -> ModelsUiState(isLoading = false, loadError = loaded.error)
            is Loadable.Loaded -> {
                val models = loaded.value
                ModelsUiState(
                    isLoading = false,
                    providers = models.providers,
                    providerId = models.providerId,
                    roles = ModelRole.entries.mapNotNull { role ->
                        models.roles[role]?.let { RoleRow(role, models.modelName(it.model), it.effort) }
                    },
                    isChanging = settings.isChangingModels,
                    changeError = settings.modelsChangeError,
                    editor = editor?.let { RoleEditorState(it.role, models.models, it.model.model, it.model.effort) },
                )
            }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ModelsUiState())

    init {
        retry()
        // New settings that lack the open sheet's model, or that model's effort, close the sheet.
        viewModelScope.launch {
            settingsRepository.settings.map { it.models }.distinctUntilChanged().collect { loaded ->
                editor.update { draft ->
                    val models = loaded.valueOrNull?.models.orEmpty()
                    val model = models.firstOrNull { it.id == draft?.model?.model }
                    val effort = draft?.model?.effort
                    if (model == null || (effort != null && effort !in model.efforts)) {
                        null
                    } else {
                        draft
                    }
                }
            }
        }
    }

    fun retry() {
        settingsRepository.reloadModels()
    }

    fun selectProvider(providerId: String) {
        settingsRepository.setProvider(providerId)
    }

    /** No sheet opens while a change is being verified. */
    fun openRole(role: ModelRole) {
        if (settingsRepository.settings.value.isChangingModels) {
            return
        }
        val model = settingsRepository.settings.value.models.valueOrNull?.roles?.get(role) ?: return
        editor.value = EditorDraft(role, model)
    }

    /** An effort the new model does not support falls back to the model's own default. */
    fun onEditorModel(modelId: String) {
        val efforts = settingsRepository.settings.value.models.valueOrNull?.models?.firstOrNull { it.id == modelId }?.efforts.orEmpty()
        editor.update { draft ->
            draft?.let {
                var effort = it.model.effort
                if (effort !in efforts) {
                    effort = null
                }
                it.copy(model = it.model.copy(model = modelId, effort = effort))
            }
        }
    }

    fun onEditorEffort(effort: Effort?) {
        editor.update { it?.copy(model = it.model.copy(effort = effort)) }
    }

    fun saveRole() {
        val current = editor.value ?: return
        editor.value = null
        settingsRepository.setRoleModel(current.role, current.model)
    }

    fun resetRole() {
        val current = editor.value ?: return
        editor.value = null
        settingsRepository.resetRole(current.role)
    }

    fun dismissEditor() {
        editor.value = null
    }

    companion object {
        val Factory = viewModelFactory {
            initializer { ModelsViewModel(appContainer().settingsRepository) }
        }
    }
}
