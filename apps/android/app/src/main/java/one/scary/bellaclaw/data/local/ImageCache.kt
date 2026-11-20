package one.scary.bellaclaw.data.local

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import one.scary.bellaclaw.model.Session

/**
 * Images from the server, as files in [dir], in the app's cache directory: Android may clear it, and it is
 * never backed up. One folder per account, named by a hash of its server and username; each image by a
 * hash of its conversation key and media id, so no name holds account data. Only the signed-in account's
 * folder is kept.
 */
class ImageCache(
    private val dir: File,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    /** The image [mediaId] of [conversationKey] for [session]'s account, or null when it is not kept. */
    suspend fun get(session: Session, conversationKey: String, mediaId: String): File? = withContext(ioDispatcher) {
        file(session, conversationKey, mediaId).takeIf { it.exists() }
    }

    /** Keeps [bytes] as the image [mediaId] of [conversationKey] for [session]'s account, whole or not at all. */
    suspend fun put(session: Session, conversationKey: String, mediaId: String, bytes: ByteArray): File = withContext(ioDispatcher) {
        val target = file(session, conversationKey, mediaId)
        target.parentFile?.mkdirs()
        val temporary = File.createTempFile("image", ".tmp", target.parentFile)
        temporary.writeBytes(bytes)
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        target
    }

    /** Deletes the images of every account but [session]'s; of every account when signed out. */
    suspend fun keepOnly(session: Session?) = withContext(ioDispatcher) {
        val kept = session?.let(::folderName)
        dir.listFiles()?.filter { it.name != kept }?.forEach { it.deleteRecursively() }
    }

    private fun file(session: Session, conversationKey: String, mediaId: String) =
        File(File(dir, folderName(session)), hash("$conversationKey\n$mediaId"))

    private fun folderName(session: Session) = hash("${session.serverUrl}\n${session.username}")

    private fun hash(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
}
