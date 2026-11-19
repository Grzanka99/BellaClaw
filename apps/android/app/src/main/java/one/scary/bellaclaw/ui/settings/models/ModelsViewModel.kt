package one.scary.bellaclaw.ui.settings.models

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.RoleModel
import one.scary.bellaclaw.ui.appContainer

class ModelsViewModel(private val settingsRepository: SettingsRepository) : ViewModel() {
    /** The open role sheet's unsaved choice; the sheet's model list comes from the settings. */
    private data class EditorDraft(val role: ModelRole, val model: RoleModel)

    private val editor = MutableStateFlow<EditorDraft?>(null)

    val uiState: StateFlow<ModelsUiState> = combine(settingsRepository.settings, editor) { settings, editor ->
        val models = settings.models
        ModelsUiState(
            providers = settings.providers,
            providerId = models.providerId,
            roles = ModelRole.entries.map { role ->
                val model = models.roles.getValue(role)
                RoleRow(role, model.model, model.effort, models.isCustom(role))
            },
            editor = editor?.let { RoleEditorState(it.role, settings.provider.models, it.model.model, it.model.effort) },
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ModelsUiState())

    fun selectProvider(providerId: String) {
        viewModelScope.launch {
            settingsRepository.setProvider(providerId)
        }
    }

    fun openRole(role: ModelRole) {
        editor.value = EditorDraft(role, settingsRepository.settings.value.models.roles.getValue(role))
    }

    fun onEditorModel(model: String) {
        editor.update { it?.copy(model = it.model.copy(model = model)) }
    }

    fun onEditorEffort(effort: Effort) {
        editor.update { it?.copy(model = it.model.copy(effort = effort)) }
    }

    fun saveRole() {
        val current = editor.value ?: return
        editor.value = null
        viewModelScope.launch {
            settingsRepository.setRoleModel(current.role, current.model)
        }
    }

    fun resetRole() {
        val current = editor.value ?: return
        editor.value = null
        viewModelScope.launch {
            settingsRepository.resetRole(current.role)
        }
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
