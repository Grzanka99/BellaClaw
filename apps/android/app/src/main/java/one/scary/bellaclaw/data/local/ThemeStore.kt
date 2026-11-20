package one.scary.bellaclaw.data.local

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.model.ThemeSettings

/**
 * The app theme, kept as JSON in [file]. The file is read once, here, so the first frame has the
 * right theme; a missing or unreadable file means the default theme.
 */
class ThemeStore(
    private val file: File,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutex = Mutex()

    /** The theme as the file held it when the store was created. */
    val theme: ThemeSettings = read()

    suspend fun save(theme: ThemeSettings) {
        mutex.withLock {
            withContext(ioDispatcher) {
                val temporary = File(file.parentFile, "${file.name}.tmp")
                temporary.writeText(json.encodeToString(StoredTheme.serializer(), StoredTheme(theme.mode, theme.dynamicColor)))
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            }
        }
    }

    private fun read(): ThemeSettings {
        if (!file.exists()) {
            return ThemeSettings()
        }
        return try {
            val stored = json.decodeFromString(StoredTheme.serializer(), file.readText())
            ThemeSettings(stored.mode, stored.dynamicColor)
        } catch (_: IOException) {
            ThemeSettings()
        } catch (_: IllegalArgumentException) {
            // SerializationException included.
            ThemeSettings()
        }
    }

    @Serializable
    private class StoredTheme(
        val mode: ThemeMode = ThemeMode.SYSTEM,
        val dynamicColor: Boolean = false,
    )

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
