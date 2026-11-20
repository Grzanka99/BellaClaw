package one.scary.bellaclaw.data.local

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelChoice

/**
 * What the phone keeps per conversation key: the model picked for a plain chat, and the newest row id
 * seen with its screen open; and the model a plain chat was last set to or sent with ([lastModel]).
 */
data class LocalChats(
    val models: Map<String, ModelChoice> = emptyMap(),
    val lastSeen: Map<String, Long> = emptyMap(),
    val lastModel: ModelChoice? = null,
)

/** [LocalChats] as JSON in [file], written through a temporary file. A missing or unreadable file holds nothing. */
class ChatStore(
    private val file: File,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutex = Mutex()
    private val state = MutableStateFlow(read())

    val chats: StateFlow<LocalChats> = state.asStateFlow()

    /** Picks [model] for the chat; it becomes the model used last. */
    suspend fun setModel(conversationKey: String, model: ModelChoice) {
        change { it.copy(models = it.models + (conversationKey to model), lastModel = model) }
    }

    /** Raises the chat's last seen row to [rowId]; a lower id changes nothing. */
    suspend fun markSeen(conversationKey: String, rowId: Long) {
        change { current ->
            if ((current.lastSeen[conversationKey] ?: -1) >= rowId) {
                current
            } else {
                current.copy(lastSeen = current.lastSeen + (conversationKey to rowId))
            }
        }
    }

    suspend fun forget(conversationKey: String) {
        change { it.copy(models = it.models - conversationKey, lastSeen = it.lastSeen - conversationKey) }
    }

    private suspend fun change(transform: (LocalChats) -> LocalChats) {
        mutex.withLock {
            val next = transform(state.value)
            if (next == state.value) {
                return
            }
            val stored = StoredChats(
                models = next.models.mapValues { (_, model) -> model.stored() },
                lastSeen = next.lastSeen,
                lastModel = next.lastModel?.stored(),
            )
            withContext(ioDispatcher) {
                val temporary = File(file.parentFile, "${file.name}.tmp")
                temporary.writeText(json.encodeToString(StoredChats.serializer(), stored))
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            }
            state.value = next
        }
    }

    private fun read(): LocalChats {
        if (!file.exists()) {
            return LocalChats()
        }
        val stored = try {
            json.decodeFromString(StoredChats.serializer(), file.readText())
        } catch (_: IOException) {
            return LocalChats()
        } catch (_: IllegalArgumentException) {
            // SerializationException included.
            return LocalChats()
        }
        return LocalChats(stored.models.mapValues { (_, model) -> model.choice() }, stored.lastSeen, stored.lastModel?.choice())
    }

    private fun ModelChoice.stored() = StoredModel(providerId, model, effort)

    @Serializable
    private class StoredModel(val providerId: String, val model: String, val effort: Effort) {
        fun choice() = ModelChoice(providerId, model, effort)
    }

    @Serializable
    private class StoredChats(
        val models: Map<String, StoredModel> = emptyMap(),
        val lastSeen: Map<String, Long> = emptyMap(),
        val lastModel: StoredModel? = null,
    )

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
