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
 * The one client of the gateway's app API. Every request carries `X-BellaClaw-Client: app` and a
 * JSON body with a `Content-Length`; a signed-in request also carries the session's bearer token, and
 * its `401` ends the session in [sessionStore]. Redirects are not followed: a redirect answer is an API
 * error, so a body holding a password or a token never goes to another address. The read timeout covers
 * the server's longest wait (a link waits up to 60 seconds for the assistant).
 */
class ApiClient(@PublishedApi internal val sessionStore: SessionStore) {
    private val http = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /** POSTs [body] to [path] on [serverUrl] without a session: sign-in and link checks. */
    suspend inline fun <reified B, reified R> post(serverUrl: String, path: String, body: B): ApiResult<R> =
        exchange(serverUrl + path, bearer = null, json.encodeToString(body)) { json.decodeFromString<R>(it) }

    /** POSTs [body] to [path] on the session's server with its token; a missing session answers as a `401` would. */
    suspend inline fun <reified B, reified R> postSignedIn(path: String, body: B): ApiResult<R> {
        val session = sessionStore.session.value ?: return ApiResult.ApiError(UNAUTHORIZED, null)
        val result = exchange(session.serverUrl + path, session.token, json.encodeToString(body)) {
            json.decodeFromString<R>(it)
        }
        if (result is ApiResult.ApiError && result.status == UNAUTHORIZED) {
            sessionStore.end(session.token)
        }
        return result
    }

    @PublishedApi
    internal suspend fun <R> exchange(url: String, bearer: String?, body: String, decode: (String) -> R): ApiResult<R> {
        val builder = Request.Builder()
            .header(CLIENT_HEADER, "app")
            .post(body.toRequestBody(JSON))
        if (bearer != null) {
            builder.header("Authorization", "Bearer $bearer")
        }
        val request = try {
            builder.url(url).build()
        } catch (_: IllegalArgumentException) {
            // A host that passes checkServerUrl but OkHttp refuses (a label over 63 characters, a bad xn-- label).
            return ApiResult.NetworkFailure
        }
        val answer = execute(http.newCall(request)) ?: return ApiResult.NetworkFailure
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

        @PublishedApi
        internal val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }

        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
