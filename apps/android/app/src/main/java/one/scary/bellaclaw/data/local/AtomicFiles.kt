package one.scary.bellaclaw.data.local

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.json.Json

/** The JSON of the files the app keeps and of a push: a field this version does not know is skipped. */
internal val lenientJson = Json { ignoreUnknownKeys = true }

/**
 * Writes [bytes] to [temporary], then moves it over this file in one step, so a reader sees the old file or
 * the new one, never a part. The default [temporary] has a fixed name, so a store that writes under a lock
 * reuses it (and the backup rules can name it); writes that may run at once pass their own.
 */
internal fun File.writeAtomically(bytes: ByteArray, temporary: File = File(parentFile, "$name.tmp")) {
    temporary.writeBytes(bytes)
    Files.move(temporary.toPath(), toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
}
