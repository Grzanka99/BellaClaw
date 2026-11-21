package one.scary.bellaclaw.data

import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.StateFlow
import one.scary.bellaclaw.data.local.ImageCache
import one.scary.bellaclaw.data.local.PickedImages
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.MediaBody
import one.scary.bellaclaw.model.ImageCheck
import one.scary.bellaclaw.model.ImageRefusal
import one.scary.bellaclaw.model.PickedImage
import one.scary.bellaclaw.model.Session

/**
 * [ChatRepository]'s images: checks a picked image against the server's limits, uploads it, and downloads
 * history's images into [cache] for the current [session]'s account. An image the server no longer keeps
 * (`410`) is not asked for again in the session.
 */
internal class ChatImages(
    private val api: ApiClient,
    private val session: StateFlow<Session?>,
    private val picked: PickedImages,
    private val cache: ImageCache,
) {
    private val gone = ConcurrentHashMap.newKeySet<String>()

    /** A session started or ended: only its account's images stay. */
    suspend fun onSession(current: Session?) {
        gone.clear()
        cache.keepOnly(current)
    }

    /**
     * The image at [uri] if the server takes it: JPEG, PNG, WebP or GIF, 5 MB at most. A file whose
     * provider reports no size is read, up to one byte past the limit, to tell.
     */
    suspend fun check(uri: String): ImageCheck {
        val file = picked.describe(uri)
        if (file == null || file.mimeType !in TYPES) {
            return ImageCheck.Refused(ImageRefusal.UNSUPPORTED_TYPE)
        }
        if (file.size > MAX_BYTES) {
            return ImageCheck.Refused(ImageRefusal.TOO_LARGE)
        }
        if (file.size < 0) {
            val bytes = picked.read(uri, MAX_BYTES + 1) ?: return ImageCheck.Refused(ImageRefusal.UNSUPPORTED_TYPE)
            if (bytes.size > MAX_BYTES) {
                return ImageCheck.Refused(ImageRefusal.TOO_LARGE)
            }
        }
        return ImageCheck.Ready(PickedImage(uri, file.mimeType))
    }

    /** Uploads [image] to [key]. Its bytes are kept under the answer's id, so its history row needs no download. */
    suspend fun upload(key: String, image: PickedImage): ApiResult<MediaBody> {
        val current = session.value
        // A file that can no longer be read, or grew past the limit since it was checked, fails like a lost
        // connection; a retry reads it again.
        val bytes = picked.read(image.uri, MAX_BYTES + 1)?.takeIf { it.size <= MAX_BYTES } ?: return ApiResult.NetworkFailure
        val result = api.postBytesSignedIn<MediaBody>(mediaPath(key), bytes, image.mimeType)
        if (result is ApiResult.Success && current != null) {
            keep(current, key, result.value.id, bytes)
        }
        return result
    }

    /** The image [mediaId] of [key], from the cache or downloaded; null when gone, signed out or not reachable now. */
    suspend fun file(key: String, mediaId: String): File? {
        val current = session.value ?: return null
        cache.get(current, key, mediaId)?.let { return it }
        if (mediaId in gone) {
            return null
        }
        return when (val result = api.getBytesSignedIn("${mediaPath(key)}/$mediaId")) {
            is ApiResult.Success -> keep(current, key, mediaId, result.value)
            is ApiResult.ApiError -> {
                if (result.status == GONE) {
                    gone.add(mediaId)
                }
                null
            }
            ApiResult.NetworkFailure -> null
        }
    }

    /** Writes [bytes] to the cache while [current] is still the session; null when it is not, or the write failed. */
    private suspend fun keep(current: Session, key: String, mediaId: String, bytes: ByteArray): File? {
        if (session.value != current) {
            return null
        }
        return try {
            cache.put(current, key, mediaId, bytes)
        } catch (_: IOException) {
            null
        }
    }

    private companion object {
        const val GONE = 410
        const val MAX_BYTES = 5 * 1024 * 1024
        val TYPES = setOf("image/jpeg", "image/png", "image/webp", "image/gif")
    }
}

private fun mediaPath(key: String) = "/api/conversations/$key/media"
