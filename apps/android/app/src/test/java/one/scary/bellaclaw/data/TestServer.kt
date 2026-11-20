package one.scary.bellaclaw.data

import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.model.Session
import org.junit.rules.ExternalResource

/** A mock gateway on localhost, and the real store, client and repository on it with a session file in a fresh folder. */
class TestServer : ExternalResource() {
    val server = MockWebServer()
    private lateinit var folder: File

    /** The server's address, as checkServerUrl leaves it. */
    val url: String
        get() = server.url("/").toString().trimEnd('/')

    val sessionFile: File
        get() = File(folder, "session.json")

    override fun before() {
        server.start()
        folder = Files.createTempDirectory("bellaclaw-test").toFile()
    }

    override fun after() {
        server.close()
        folder.deleteRecursively()
    }

    fun store() = SessionStore(sessionFile)

    fun repository(store: SessionStore = store(), allowCleartext: Boolean = true) =
        AccountRepository(ApiClient(store), store, allowCleartext, Mutex())

    /** A store signed in to this server as `ada` with token `t0`. */
    suspend fun signedInStore(serverUrl: String = url): SessionStore = store().also { it.save(Session(serverUrl, "ada", "t0")) }

    fun answer(code: Int, body: String, delayMillis: Long = 0) {
        server.enqueue(
            MockResponse.Builder()
                .code(code)
                .body(body)
                .headersDelay(delayMillis, TimeUnit.MILLISECONDS)
                .build(),
        )
    }

    fun takeRequest(): RecordedRequest = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS)) { "no request arrived" }
}

fun RecordedRequest.json(): JsonObject = Json.parseToJsonElement(checkNotNull(body).utf8()).jsonObject

/** The answer of register, login and link login to the app. */
fun sessionAnswer(username: String, token: String) = """{"username":"$username","chats":[],"token":"$token"}"""

fun errorAnswer(text: String) = """{"error":"$text"}"""
