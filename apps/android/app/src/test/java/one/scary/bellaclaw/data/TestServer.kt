package one.scary.bellaclaw.data

import java.io.File
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.QueueDispatcher
import mockwebserver3.RecordedRequest
import one.scary.bellaclaw.data.local.ChatStore
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.data.local.ThemeStore
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.model.Session
import org.junit.rules.ExternalResource

private const val LOOPBACK = "127.0.0.1"

/** A mock gateway on 127.0.0.1, and the real store, client and repository on it with a session file in a fresh folder. */
class TestServer : ExternalResource() {
    val server = MockWebServer()
    private lateinit var folder: File

    /** Answers by `METHOD path`, every time, ahead of the queue of [answer]. */
    private val routes = ConcurrentHashMap<String, MockResponse>()

    /**
     * The server's address, as checkServerUrl leaves it. By IP, not `localhost`: OkHttp tries `::1` first, where
     * another process (the emulator) may listen on the same port and never answer.
     */
    val url: String
        get() = "http://$LOOPBACK:${server.port}"

    val sessionFile: File
        get() = File(folder, "session.json")

    override fun before() {
        server.dispatcher = object : QueueDispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                routes["${request.method} ${request.url.encodedPath}"] ?: super.dispatch(request)
        }
        server.start(InetAddress.getByName(LOOPBACK), 0)
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

    /** Answers with a [FakeGateway] from now on, instead of what [answer] queues; [route] still answers first. */
    fun gateway(): FakeGateway = FakeGateway().also { gateway ->
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                routes["${request.method} ${request.url.encodedPath}"] ?: gateway.dispatch(request)

            override fun close() {
                gateway.close()
            }
        }
    }

    /**
     * The real chat repository on [store]'s session, its local file in this folder; in the foreground unless
     * [foreground] says otherwise; the account's models from [settings]; tries again after [retryMillis].
     */
    fun chatRepository(
        store: SessionStore,
        scope: CoroutineScope,
        foreground: Flow<Boolean> = MutableStateFlow(true),
        settings: SettingsRepository = settingsRepository(store, scope),
        retryMillis: Long = 1_000L,
    ) = ChatRepository(ApiClient(store), store.session, foreground, settings.settings, ChatStore(File(folder, "chats.json")), scope, retryMillis = retryMillis)

    fun answer(code: Int, body: String, delayMillis: Long = 0) {
        server.enqueue(
            MockResponse.Builder()
                .code(code)
                .body(body)
                .headersDelay(delayMillis, TimeUnit.MILLISECONDS)
                .build(),
        )
    }

    /** Answers every [method] request to [path] this way from now on, whatever arrives before it. */
    fun route(method: String, path: String, code: Int, body: String, delayMillis: Long = 0) {
        routes["$method $path"] = MockResponse.Builder()
            .code(code)
            .body(body)
            .headersDelay(delayMillis, TimeUnit.MILLISECONDS)
            .build()
    }

    /** Writes in place, so a theme change is on disk when the call that made it returns. */
    fun themeStore() = ThemeStore(File(folder, "theme.json"), Dispatchers.Unconfined)

    /**
     * The real settings repository on [store]'s session, running its work in [scope]. The model, model
     * list and personality reads answer [modelAnswer], [chatModelsAnswer] and [personalityAnswer] unless
     * a test routed them already.
     */
    fun settingsRepository(store: SessionStore = store(), scope: CoroutineScope): SettingsRepository {
        if (!routes.containsKey("GET /api/model")) {
            route("GET", "/api/model", 200, modelAnswer())
        }
        if (!routes.containsKey("GET /api/models")) {
            route("GET", "/api/models", 200, chatModelsAnswer())
        }
        if (!routes.containsKey("GET /api/personality")) {
            route("GET", "/api/personality", 200, personalityAnswer())
        }
        return SettingsRepository(ApiClient(store), store.session, themeStore(), scope)
    }

    fun takeRequest(): RecordedRequest = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS)) { "no request arrived" }

    /** The next [method] request to [path]; the requests before it are skipped. */
    fun takeRequest(method: String, path: String): RecordedRequest {
        while (true) {
            val request = takeRequest()
            if (request.method == method && request.url.encodedPath == path) {
                return request
            }
        }
    }
}

fun RecordedRequest.json(): JsonObject = Json.parseToJsonElement(checkNotNull(body).utf8()).jsonObject

/** The answer of register, login and link login to the app. */
fun sessionAnswer(username: String, token: String) = """{"username":"$username","chats":[],"token":"$token"}"""

fun errorAnswer(text: String) = """{"error":"$text"}"""

/**
 * GET and PUT /api/model: provider opencode-go of two, its models Kimi K3.1 Pro (low to high) and
 * GLM 5 (low, high), Main on [mainModel] at the model's default, Utility on GLM 5 at low and every
 * other role on Kimi at the model's default.
 */
fun modelAnswer(mainModel: String = "kimi-k3.1-pro"): String {
    fun purpose(name: String, model: String, effort: String) =
        """{"purpose":"$name","model":"$model","effort":"$effort","serviceTier":"default"}"""
    val purposes = listOf(
        purpose("Utility", "glm-5", "low"),
        purpose("Main", mainModel, "default"),
        purpose("Specialist", "kimi-k3.1-pro", "default"),
        purpose("SpecialistAccurate", "kimi-k3.1-pro", "default"),
        purpose("ScheduledTask", "kimi-k3.1-pro", "default"),
    ).joinToString(",")
    return """{"provider":"opencode-go","providers":["opencode-go","openai-codex"],"purposes":[$purposes],""" +
        """"availableModels":[""" +
        """{"id":"kimi-k3.1-pro","name":"Kimi K3.1 Pro","supportedEfforts":["low","medium","high"],"supportsServiceTier":false},""" +
        """{"id":"glm-5","name":"GLM 5","supportedEfforts":["low","high"],"supportsServiceTier":false}]}"""
}

/**
 * GET /api/models: opencode-go, usable, with Kimi K3.1 Pro (low to high) and GLM 5 (low, high); then
 * openai-codex, usable when [codexReason] is null, with GPT 5.5 (low to xhigh).
 */
fun chatModelsAnswer(codexReason: String? = "The OpenAI Codex login is not connected"): String {
    val codex = if (codexReason == null) """"usable":true""" else """"usable":false,"reason":"$codexReason""""
    return """{"providers":[""" +
        """{"id":"opencode-go","usable":true,"models":[""" +
        """{"id":"kimi-k3.1-pro","name":"Kimi K3.1 Pro","supportedEfforts":["low","medium","high"]},""" +
        """{"id":"glm-5","name":"GLM 5","supportedEfforts":["low","high"]}]},""" +
        """{"id":"openai-codex",$codex,"models":[""" +
        """{"id":"gpt-5.5","name":"GPT 5.5","supportedEfforts":["low","medium","high","xhigh"]}]}]}"""
}

/** GET and PUT /api/personality. */
fun personalityAnswer(bella: String = "You are BellaClaw.", useInChats: Boolean = true, chats: String = "Keep it short.") =
    """{"bellaPersona":"$bella","plainChatsUseBellaPersona":$useInChats,"plainChatsPersona":"$chats"}"""
