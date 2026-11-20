package one.scary.bellaclaw.data.remote

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import one.scary.bellaclaw.data.local.SessionStore

/**
 * The one client of the gateway's app API. Every request carries `X-BellaClaw-Client: app`; a POST or
 * PUT carries a JSON body with a `Content-Length`; a signed-in request also carries the session's
 * bearer token, and its `401` ends the session in [sessionStore]. Redirects are not followed: a redirect answer is an API
 * error, so a body holding a password or a token never goes to another address. The read timeout covers
 * the server's longest wait (a link waits up to 60 seconds for the assistant).
 */
class ApiClient(@PublishedApi internal val sessionStore: SessionStore) {
    private val http = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /** [http] with a read timeout for an answer that waits minutes: a model change the assistant verifies with the provider. */
    private val longWaitHttp = http.newBuilder()
        .readTimeout(LONG_WAIT_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /** POSTs [body] to [path] on [serverUrl] without a session: sign-in and link checks. */
    suspend inline fun <reified B, reified R> post(serverUrl: String, path: String, body: B): ApiResult<R> =
        exchange("POST", serverUrl + path, bearer = null, json.encodeToString(body)) { json.decodeFromString<R>(it) }

    /** GETs [path] on the session's server with its token; a missing session answers as a `401` would, here and below. */
    suspend inline fun <reified R> getSignedIn(path: String): ApiResult<R> =
        signedIn("GET", path, body = null) { json.decodeFromString<R>(it) }

    /** POSTs [body] to [path] on the session's server with its token. */
    suspend inline fun <reified B, reified R> postSignedIn(path: String, body: B): ApiResult<R> =
        signedIn("POST", path, json.encodeToString(body)) { json.decodeFromString<R>(it) }

    /** PUTs [body] to [path] on the session's server with its token. */
    suspend inline fun <reified B, reified R> putSignedIn(path: String, body: B): ApiResult<R> =
        signedIn("PUT", path, json.encodeToString(body)) { json.decodeFromString<R>(it) }

    /** PUTs [body] to [path] like [putSignedIn], waiting up to [LONG_WAIT_READ_TIMEOUT_SECONDS] for the answer. */
    suspend inline fun <reified B, reified R> putSignedInLongWait(path: String, body: B): ApiResult<R> =
        signedIn("PUT", path, json.encodeToString(body), longWait = true) { json.decodeFromString<R>(it) }

    /** DELETEs [path] on the session's server with its token. */
    suspend inline fun <reified R> deleteSignedIn(path: String): ApiResult<R> =
        signedIn("DELETE", path, body = null) { json.decodeFromString<R>(it) }

    @PublishedApi
    internal suspend fun <R> signedIn(
        method: String,
        path: String,
        body: String?,
        longWait: Boolean = false,
        decode: (String) -> R,
    ): ApiResult<R> {
        val session = sessionStore.session.value ?: return ApiResult.ApiError(UNAUTHORIZED, null)
        val result = exchange(method, session.serverUrl + path, session.token, body, longWait, decode)
        if (result is ApiResult.ApiError && result.status == UNAUTHORIZED) {
            sessionStore.end(session.token)
        }
        return result
    }

    @PublishedApi
    internal suspend fun <R> exchange(
        method: String,
        url: String,
        bearer: String?,
        body: String?,
        longWait: Boolean = false,
        decode: (String) -> R,
    ): ApiResult<R> {
        val builder = Request.Builder()
            .header(CLIENT_HEADER, "app")
            .method(method, body?.toRequestBody(JSON))
        if (bearer != null) {
            builder.header("Authorization", "Bearer $bearer")
        }
        val request = try {
            builder.url(url).build()
        } catch (_: IllegalArgumentException) {
            // A host that passes checkServerUrl but OkHttp refuses (a label over 63 characters, a bad xn-- label).
            return ApiResult.NetworkFailure
        }
        val client = if (longWait) {
            longWaitHttp
        } else {
            http
        }
        val answer = execute(client.newCall(request)) ?: return ApiResult.NetworkFailure
        val (status, text) = answer
        if (status !in 200..299) {
            return ApiResult.ApiError(status, errorText(text))
        }
        return try {
            ApiResult.Success(decode(text))
        } catch (_: IllegalArgumentException) {
            // SerializationException included.
            ApiResult.ApiError(status, null)
        }
    }

    /** The status and body text of the answer, or null when there was none. */
    private suspend fun execute(call: Call): Pair<Int, String>? = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resume(null)
            }

            override fun onResponse(call: Call, response: Response) {
                val answer = try {
                    response.use { it.code to it.body.string() }
                } catch (_: IOException) {
                    null
                }
                continuation.resume(answer)
            }
        })
    }

    private fun errorText(text: String): String? = try {
        json.decodeFromString<ErrorBody>(text).error
    } catch (_: IllegalArgumentException) {
        // SerializationException included.
        null
    }

    companion object {
        const val CLIENT_HEADER = "X-BellaClaw-Client"
        const val UNAUTHORIZED = 401
        private const val READ_TIMEOUT_SECONDS = 70L

        /** Past the gateway's 250 s wait for the assistant and its 255 s idle timeout, so their answer arrives first. */
        private const val LONG_WAIT_READ_TIMEOUT_SECONDS = 270L

        @PublishedApi
        internal val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }

        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
