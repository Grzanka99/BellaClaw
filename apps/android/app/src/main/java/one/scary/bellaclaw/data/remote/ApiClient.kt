package one.scary.bellaclaw.data.remote

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import one.scary.bellaclaw.data.local.SessionStore

/**
 * The one client of the gateway's app API. Every request carries `X-BellaClaw-Client: app`; a POST or
 * PUT carries a body with a `Content-Length`: JSON, or an image upload's bytes; a signed-in request also carries the session's
 * bearer token, and its `401` ends the session in [sessionStore]. Redirects are not followed: a redirect answer is an API
 * error, so a body holding a password or a token never goes to another address. The read timeout covers
 * the server's longest wait (a link waits up to 60 seconds for the assistant).
 */
class ApiClient(private val sessionStore: SessionStore) {
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
        exchange("POST", serverUrl + path, bearer = null, jsonBodyOf(body), decode = decodeJson())

    /** GETs [path] on the session's server with its token; a missing session answers as a `401` would, here and below. */
    suspend inline fun <reified R> getSignedIn(path: String): ApiResult<R> =
        signedIn("GET", path, body = null, decode = decodeJson())

    /** GETs the bytes at [path] on the session's server with its token: an image. */
    suspend fun getBytesSignedIn(path: String): ApiResult<ByteArray> = signedIn("GET", path, body = null) { it }

    /** POSTs [body] to [path] on the session's server with its token. */
    suspend inline fun <reified B, reified R> postSignedIn(path: String, body: B): ApiResult<R> =
        signedIn("POST", path, jsonBodyOf(body), decode = decodeJson())

    /** POSTs [bytes] of [contentType] to [path] on the session's server with its token: an image upload. */
    suspend inline fun <reified R> postBytesSignedIn(path: String, bytes: ByteArray, contentType: String): ApiResult<R> =
        signedIn("POST", path, bytes.toRequestBody(contentType.toMediaType()), decode = decodeJson())

    /** PUTs [body] to [path] on the session's server with its token. */
    suspend inline fun <reified B, reified R> putSignedIn(path: String, body: B): ApiResult<R> =
        signedIn("PUT", path, jsonBodyOf(body), decode = decodeJson())

    /** PUTs [body] to [path] like [putSignedIn], waiting up to [LONG_WAIT_READ_TIMEOUT_SECONDS] for the answer. */
    suspend inline fun <reified B, reified R> putSignedInLongWait(path: String, body: B): ApiResult<R> =
        signedIn("PUT", path, jsonBodyOf(body), longWait = true, decode = decodeJson())

    /**
     * Reads the server-sent event stream at [path] on the session's server with its token, handing each
     * event's type and data to [onEvent] (on an IO thread) until the stream ends: [ApiResult.Success]
     * when the server closed it, [ApiResult.NetworkFailure] when the connection broke. Cancelling the
     * caller closes the connection. A `401` ends the session as with [getSignedIn].
     */
    suspend fun streamSignedIn(path: String, onEvent: (type: String, data: String) -> Unit): ApiResult<Unit> {
        val session = sessionStore.session.value ?: return ApiResult.ApiError(UNAUTHORIZED, null)
        val request = request("GET", session.serverUrl + path, session.token, body = null) ?: return ApiResult.NetworkFailure
        val call = http.newCall(request)
        val result = coroutineScope {
            // The blocking read below does not see cancellation; cancelling the call ends it.
            val canceller = launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    awaitCancellation()
                } finally {
                    call.cancel()
                }
            }
            try {
                withContext(Dispatchers.IO) { readEvents(call, onEvent) }
            } finally {
                canceller.cancel()
            }
        }
        if (result is ApiResult.ApiError && result.status == UNAUTHORIZED) {
            sessionStore.end(session.token)
        }
        return result
    }

    private fun readEvents(call: Call, onEvent: (type: String, data: String) -> Unit): ApiResult<Unit> = try {
        call.execute().use { response ->
            if (!response.isSuccessful) {
                return ApiResult.ApiError(response.code, errorText(response.body.string()))
            }
            val source = response.body.source()
            var type = ""
            while (true) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.startsWith("event:") -> type = line.removePrefix("event:").trim()
                    line.startsWith("data:") -> onEvent(type, line.removePrefix("data:").trim())
                    // The keep-alive comment.
                    else -> Unit
                }
            }
            ApiResult.Success(Unit)
        }
    } catch (_: IOException) {
        ApiResult.NetworkFailure
    }

    @PublishedApi
    internal suspend fun <R> signedIn(
        method: String,
        path: String,
        body: RequestBody?,
        longWait: Boolean = false,
        decode: (ByteArray) -> R,
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
        body: RequestBody?,
        longWait: Boolean = false,
        decode: (ByteArray) -> R,
    ): ApiResult<R> {
        val request = request(method, url, bearer, body) ?: return ApiResult.NetworkFailure
        val client = if (longWait) {
            longWaitHttp
        } else {
            http
        }
        val answer = execute(client.newCall(request)) ?: return ApiResult.NetworkFailure
        val (status, bytes) = answer
        if (status !in 200..299) {
            return ApiResult.ApiError(status, errorText(bytes.decodeToString()))
        }
        return try {
            ApiResult.Success(decode(bytes))
        } catch (_: IllegalArgumentException) {
            // SerializationException included.
            ApiResult.ApiError(status, null)
        }
    }

    /** The request with the client header and, given a [bearer], its token; null when OkHttp refuses [url] or the token. */
    private fun request(method: String, url: String, bearer: String?, body: RequestBody?): Request? = try {
        val builder = Request.Builder()
            .header(CLIENT_HEADER, "app")
            .method(method, body)
        if (bearer != null) {
            builder.header("Authorization", "Bearer $bearer")
        }
        builder.url(url).build()
    } catch (_: IllegalArgumentException) {
        // A host that passes checkServerUrl but OkHttp refuses (a label over 63 characters, a bad xn-- label),
        // or a token that is not a valid header value.
        null
    }

    /** The status and body of the answer, or null when there was none. */
    private suspend fun execute(call: Call): Pair<Int, ByteArray>? = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resume(null)
            }

            override fun onResponse(call: Call, response: Response) {
                val answer = try {
                    response.use { it.code to it.body.bytes() }
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

        @PublishedApi
        internal val JSON = "application/json; charset=utf-8".toMediaType()

        @PublishedApi
        internal inline fun <reified R> decodeJson(): (ByteArray) -> R = { json.decodeFromString<R>(it.decodeToString()) }

        @PublishedApi
        internal inline fun <reified B> jsonBodyOf(body: B): RequestBody = json.encodeToString(body).toRequestBody(JSON)
    }
}
