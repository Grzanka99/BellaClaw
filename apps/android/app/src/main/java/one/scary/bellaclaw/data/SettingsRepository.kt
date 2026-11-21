package one.scary.bellaclaw.data

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.local.ThemeStore
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.ModelCatalogBody
import one.scary.bellaclaw.data.remote.ModelStateBody
import one.scary.bellaclaw.data.remote.ModelUpdateBody
import one.scary.bellaclaw.data.remote.PersonalityBody
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.Loadable
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.Personality
import one.scary.bellaclaw.model.RoleModel
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.model.SettingsSnapshot
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.model.ThemeSettings

/**
 * Single source of truth for settings, as one [SettingsSnapshot]: the account's models and
 * personality and the plain chats' model list from the server, loaded when a session starts, and the
 * theme from [themeStore].
 * A session that ends or changes drops the account's settings; the theme stays. An answer is
 * applied only while the session that asked is still the current one.
 */
class SettingsRepository(
    private val api: ApiClient,
    private val session: StateFlow<Session?>,
    private val themeStore: ThemeStore,
    private val scope: CoroutineScope,
) {
    private val state = MutableStateFlow(SettingsSnapshot(theme = themeStore.theme))

    /** Every change replaces the whole snapshot, so readers never see a provider list and selection that disagree. */
    val settings: StateFlow<SettingsSnapshot> = state.asStateFlow()

    /** Model changes started so far; a read that a change overtook drops its answer. */
    private val modelChanges = AtomicInteger()

    /** Reads of the models and of the model list started so far; a read that a newer one overtook drops its answer. */
    private val modelReads = AtomicInteger()
    private val chatModelReads = AtomicInteger()

    init {
        // Undispatched, so the current session is seen here, before any screen asks for a load.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            session.map { it?.token }.distinctUntilChanged().collect { token ->
                state.update { SettingsSnapshot(theme = it.theme) }
                if (token != null) {
                    scope.launch { loadModels() }
                    scope.launch { loadPersonality() }
                    scope.launch { loadChatModels() }
                }
            }
        }
    }

    /** Reads the models again, in [scope]: the read finishes when the screen that asked for it is gone. */
    fun reloadModels() {
        scope.launch { loadModels() }
    }

    /**
     * Reads the models; a failed load shows loading while it retries. The last refusal stays.
     * No read starts while a change is verified, and the answer of a read that a change or a newer read
     * overtook is dropped: their answer is newer.
     */
    private suspend fun loadModels() {
        val token = session.value?.token ?: return
        val changes = modelChanges.get()
        if (state.value.isChangingModels) {
            return
        }
        val read = modelReads.incrementAndGet()
        updateForSession(token) { it.copy(models = it.models.retrying()) }
        val result = api.getSignedIn<ModelStateBody>("/api/model")
        updateForSession(token) {
            if (modelChanges.get() == changes && modelReads.get() == read) {
                it.copy(models = result.toLoadable { body -> body.toModelSettings() })
            } else {
                it
            }
        }
    }

    /**
     * Reads again, in [scope], what a plain chat's model needs and failed to load: the account's
     * models and the model list. With [refresh], the list is read even when one is held.
     */
    fun reloadChatModels(refresh: Boolean) {
        val current = state.value
        if (current.models is Loadable.Failed) {
            scope.launch { loadModels() }
        }
        if (refresh || current.chatModels is Loadable.Failed) {
            scope.launch { loadChatModels() }
        }
    }

    /** Reads the model list; a held list stays while it is read and when the read fails. A read that a newer one overtook changes nothing. */
    private suspend fun loadChatModels() {
        val token = session.value?.token ?: return
        val read = chatModelReads.incrementAndGet()
        updateForSession(token) { it.copy(chatModels = it.chatModels.retrying()) }
        val result = api.getSignedIn<ModelCatalogBody>("/api/models")
        updateForSession(token) {
            if (chatModelReads.get() != read) {
                it
            } else if (result is ApiResult.Success || it.chatModels !is Loadable.Loaded) {
                it.copy(chatModels = result.toLoadable { body -> body.toChatProviders() })
            } else {
                it
            }
        }
    }

    suspend fun loadPersonality() {
        val token = session.value?.token ?: return
        updateForSession(token) { it.copy(personality = it.personality.retrying()) }
        val result = api.getSignedIn<PersonalityBody>("/api/personality")
        updateForSession(token) { it.copy(personality = result.toLoadable { body -> body.toPersonality() }) }
    }

    /** Switches BellaClaw to another provider; the server verifies its models first. The current provider changes nothing. */
    fun setProvider(providerId: String) {
        val models = state.value.models.valueOrNull ?: return
        if (models.providerId != providerId) {
            changeModels(ModelUpdateBody(aiProvider = providerId))
        }
    }

    /**
     * Sends what differs from the role's current model, effort and service tier; nothing when nothing
     * does. The tier is sent only for a model that supports one.
     */
    fun setRoleModel(role: ModelRole, model: RoleModel) {
        val current = state.value.models.valueOrNull?.roles?.get(role) ?: return
        var newModel: String? = null
        if (model.model != current.model) {
            newModel = model.model
        }
        var effort: String? = null
        var resetEffort: Boolean? = null
        if (model.effort != current.effort) {
            if (model.effort == null) {
                resetEffort = true
            } else {
                effort = model.effort.wireName()
            }
        }
        var serviceTier: String? = null
        val supportsServiceTier = state.value.models.valueOrNull?.models?.firstOrNull { it.id == model.model }?.supportsServiceTier == true
        if (supportsServiceTier && model.serviceTier != current.serviceTier) {
            serviceTier = model.serviceTier.wireName()
        }
        if (newModel == null && effort == null && resetEffort == null && serviceTier == null) {
            return
        }
        changeModels(
            ModelUpdateBody(
                aiModelPurpose = role.purpose(),
                aiModel = newModel,
                aiReasoningEffort = effort,
                aiServiceTier = serviceTier,
                resetAiReasoningEffort = resetEffort,
            ),
        )
    }

    /** Gives the role its provider's default model and effort. */
    fun resetRole(role: ModelRole) {
        changeModels(ModelUpdateBody(aiModelPurpose = role.purpose(), resetAiModel = true))
    }

    /** Stores [personality]; on success the snapshot holds the server's answer. Answers null on success, else why it failed. */
    suspend fun savePersonality(personality: Personality): AccountError? {
        val token = session.value?.token
        val body = PersonalityBody(personality.bellaClaw, personality.useInChats, personality.chats)
        return when (val result = api.putSignedIn<PersonalityBody, PersonalityBody>("/api/personality", body)) {
            is ApiResult.Success -> {
                updateForSession(token) { it.copy(personality = Loadable.Loaded(result.value.toPersonality())) }
                null
            }
            else -> result.error()
        }
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        saveTheme { it.copy(mode = mode) }
    }

    suspend fun setDynamicColor(enabled: Boolean) {
        saveTheme { it.copy(dynamicColor = enabled) }
    }

    private suspend fun saveTheme(change: (ThemeSettings) -> ThemeSettings) {
        themeStore.save(state.updateAndGet { it.copy(theme = change(it.theme)) }.theme)
    }

    /**
     * Sends [body] unless another change is being verified, and keeps it out of the screen's way
     * until the answer, which can take minutes. It runs in [scope], so leaving the screen does not drop it.
     */
    private fun changeModels(body: ModelUpdateBody) {
        val token = session.value?.token ?: return
        var started = false
        state.update {
            started = !it.isChangingModels
            if (started) {
                it.copy(isChangingModels = true, modelsChangeError = null)
            } else {
                it
            }
        }
        if (!started) {
            return
        }
        modelChanges.incrementAndGet()
        scope.launch {
            val result = api.putSignedInLongWait<ModelUpdateBody, ModelStateBody>("/api/model", body)
            updateForSession(token) {
                when (result) {
                    is ApiResult.Success -> it.copy(models = Loadable.Loaded(result.value.toModelSettings()), isChangingModels = false)
                    else -> it.copy(isChangingModels = false, modelsChangeError = result.error())
                }
            }
        }
    }

    private fun updateForSession(token: String?, change: (SettingsSnapshot) -> SettingsSnapshot) {
        state.update {
            if (token != null && session.value?.token == token) {
                change(it)
            } else {
                it
            }
        }
    }

    private fun <T> Loadable<T>.retrying(): Loadable<T> = when (this) {
        is Loadable.Failed -> Loadable.Loading
        else -> this
    }

    private fun <B, T> ApiResult<B>.toLoadable(transform: (B) -> T): Loadable<T> = when (this) {
        is ApiResult.Success -> Loadable.Loaded(transform(value))
        else -> Loadable.Failed(error())
    }

    /** Why a request that did not succeed failed. */
    private fun ApiResult<*>.error(): AccountError = when (this) {
        is ApiResult.ApiError -> AccountError.Server(status, message)
        else -> AccountError.Network
    }
}
