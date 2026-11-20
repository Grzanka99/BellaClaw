package one.scary.bellaclaw.data.local

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import one.scary.bellaclaw.model.Session

/**
 * The session and the last server address, kept as JSON in [file] (app-private, excluded from backup and
 * device transfer by `data_extraction_rules.xml`). The file is read once, here; a missing or unreadable
 * file means signed out with no remembered server.
 */
class SessionStore(
    private val file: File,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutex = Mutex()
    @Volatile
    private var stored = read()
    private val sessionState = MutableStateFlow(stored.toSession())

    val session: StateFlow<Session?> = sessionState.asStateFlow()

    /** The server of the current or the last session, for the sign-in form. */
    val lastServerUrl: String?
        get() = stored.serverUrl

    suspend fun save(session: Session) {
        mutex.withLock { writeLocked(StoredSession(session.serverUrl, session.username, session.token)) }
    }

    /** Ends the session if its token is still [token], so an old request cannot end a newer session. Keeps the server. */
    suspend fun end(token: String) {
        mutex.withLock {
            val current = stored
            if (current.token == token) {
                writeLocked(StoredSession(current.serverUrl))
            }
        }
    }

    private suspend fun writeLocked(value: StoredSession) {
        withContext(ioDispatcher) {
            file.writeAtomically(lenientJson.encodeToString(StoredSession.serializer(), value).encodeToByteArray())
        }
        stored = value
        sessionState.value = value.toSession()
    }

    private fun read(): StoredSession {
        if (!file.exists()) {
            return StoredSession()
        }
        return try {
            lenientJson.decodeFromString(StoredSession.serializer(), file.readText())
        } catch (_: IOException) {
            StoredSession()
        } catch (_: IllegalArgumentException) {
            // SerializationException included.
            StoredSession()
        }
    }

    @Serializable
    private class StoredSession(
        val serverUrl: String? = null,
        val username: String? = null,
        val token: String? = null,
    ) {
        fun toSession(): Session? {
            if (serverUrl == null || username == null || token == null) {
                return null
            }
            return Session(serverUrl, username, token)
        }
    }
}
