package one.scary.bellaclaw.data.local

import android.content.ContentResolver
import androidx.core.net.toUri
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A picked file's type and size in bytes (-1 when the provider does not say). */
class PickedFile(val mimeType: String, val size: Long)

/** Reads images picked with the photo picker; [ContentPickedImages] in the app, a fake in tests. */
interface PickedImages {
    /** The type and size of the file at [uri], or null when it cannot be read. */
    suspend fun describe(uri: String): PickedFile?

    /** The first [limit] bytes of the file at [uri] (all of them when it is shorter), or null when it cannot be read. */
    suspend fun read(uri: String, limit: Int): ByteArray?
}

/** Reads picked images through [resolver]; the photo picker's grant lasts as long as the process. */
class ContentPickedImages(private val resolver: ContentResolver) : PickedImages {
    override suspend fun describe(uri: String): PickedFile? = withContext(Dispatchers.IO) {
        try {
            val type = resolver.getType(uri.toUri()) ?: return@withContext null
            val size = resolver.openAssetFileDescriptor(uri.toUri(), "r")?.use { it.length } ?: return@withContext null
            PickedFile(type, size)
        } catch (_: IOException) {
            null
        } catch (_: SecurityException) {
            null
        }
    }

    override suspend fun read(uri: String, limit: Int): ByteArray? = withContext(Dispatchers.IO) {
        try {
            resolver.openInputStream(uri.toUri())?.use { it.readNBytes(limit) }
        } catch (_: IOException) {
            null
        } catch (_: SecurityException) {
            null
        }
    }
}
