package one.scary.bellaclaw.data

import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockResponseBody
import mockwebserver3.RecordedRequest
import okio.Buffer
import okio.BufferedSink

/**
 * The gateway's conversation routes and live stream over in-memory conversations, for [TestServer].
 * Rows get ids in one rising sequence; every change raises the conversation's revision, a rewrite also
 * its rewrite revision. Each stream opens with `check`, then carries what [push] sends while it is open.
 */
class FakeGateway : Dispatcher() {
    class Row(val id: Long, val author: String, val text: String, val createdAt: Long, val clientMessageId: String?, val imageIds: List<String?>, val steps: String?)

    class Conversation(val key: String, val kind: String, var title: String? = null) {
        val rows = mutableListOf<Row>()
        var revision = 0L
        var rewriteRevision = 0L
    }

    private val conversations = mutableListOf(Conversation(BELLA_KEY, "bella"))
    private var nextRowId = 1L
    /** How many chats `POST /api/conversations` created. */
    var createdChats = 0
        private set
    /** The events of each open stream, not yet written. */
    private val streams = CopyOnWriteArrayList<LinkedBlockingQueue<String>>()

    @Volatile
    private var closed = false

    /** Bodies of the sends that arrived, in order. */
    val sends = LinkedBlockingQueue<JsonObject>()

    /** Answers of the next sends, before they are accepted: status and body. */
    val sendFailures = LinkedBlockingQueue<Pair<Int, String>>()

    /** Statuses of the next list reads, which fail instead of answering. */
    val listFailures = LinkedBlockingQueue<Int>()

    /** Statuses of the next history reads, which fail instead of answering. */
    val historyFailures = LinkedBlockingQueue<Int>()

    /** Content type and bytes of the uploads that arrived, in order. */
    val uploads = LinkedBlockingQueue<Pair<String?, ByteArray>>()

    /** Answers of the next uploads, before they are stored: status and body. */
    val uploadFailures = LinkedBlockingQueue<Pair<Int, String>>()

    private val nextMediaId = AtomicInteger()

    /** The images kept, by media id. */
    private val media = ConcurrentHashMap<String, ByteArray>()

    /** How many images were downloaded. */
    @Volatile
    var downloads = 0
        private set

    /** How many streams were opened. */
    @Volatile
    var streamsOpened = 0
        private set

    @Synchronized
    fun addChat(key: String, title: String? = null) {
        conversations.add(1, Conversation(key, "plain", title))
    }

    /** Appends a row to [key] and answers its id; the conversation moves up as the latest active. [steps] is the row's `steps`, as JSON. */
    @Synchronized
    fun addRow(
        key: String,
        author: String,
        text: String,
        clientMessageId: String? = null,
        imageIds: List<String?> = emptyList(),
        steps: String? = null,
    ): Long {
        val conversation = conversation(key)
        val row = Row(nextRowId++, author, text, CREATED_AT + nextRowId * 1000, clientMessageId, imageIds, steps)
        conversation.rows.add(row)
        conversation.revision++
        if (conversation.kind == "plain") {
            conversations.remove(conversation)
            conversations.add(1, conversation)
        }
        return row.id
    }

    /** Keeps [bytes] as the image [id], for download. */
    fun addMedia(id: String, bytes: ByteArray) {
        media[id] = bytes
    }

    /** Deletes row [id] of [key]: a change that is not an append. */
    @Synchronized
    fun deleteRow(key: String, id: Long) {
        val conversation = conversation(key)
        conversation.rows.removeAll { it.id == id }
        conversation.revision++
        conversation.rewriteRevision = conversation.revision
    }

    @Synchronized
    fun deleteChat(key: String) {
        conversations.remove(conversation(key))
    }

    /** Sends a stream event of [type] with [data] (JSON) to the open streams. */
    fun push(type: String, data: String) {
        val event = "event: $type\ndata: $data\n\n"
        streams.forEach { it.put(event) }
    }

    override fun close() {
        closed = true
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val segments = request.url.pathSegments
        return when {
            request.url.encodedPath == "/api/stream" -> stream()
            request.url.encodedPath == "/api/logout" -> json("""{"ok":true}""")
            segments == listOf("api", "conversations") && request.method == "GET" ->
                listFailures.poll()?.let { failure(it, errorAnswer("Unavailable")) } ?: json(list())
            segments == listOf("api", "conversations") && request.method == "POST" -> json(create())
            segments.size == 4 && segments[3] == "messages" && request.method == "GET" ->
                historyFailures.poll()?.let { failure(it, errorAnswer("Unavailable")) }
                    ?: json(history(segments[2], request.url.queryParameter("before"), request.url.queryParameter("after")))
            segments.size == 4 && segments[3] == "messages" && request.method == "POST" -> send(request)
            segments.size == 4 && segments[3] == "media" && request.method == "POST" -> upload(request)
            segments.size == 5 && segments[3] == "media" && request.method == "GET" -> download(segments[4])
            else -> failure(404, errorAnswer("Not found"))
        }
    }

    private fun send(request: RecordedRequest): MockResponse {
        val body = request.json()
        sends.put(body)
        sendFailures.poll()?.let { (code, text) -> return failure(code, text) }
        return json("""{"clientMessageId":${body["clientMessageId"]}}""")
    }

    private fun upload(request: RecordedRequest): MockResponse {
        val type = request.headers["Content-Type"]
        val bytes = checkNotNull(request.body).toByteArray()
        uploads.put(type to bytes)
        uploadFailures.poll()?.let { (code, text) -> return failure(code, text) }
        val id = "media-${nextMediaId.incrementAndGet()}"
        media[id] = bytes
        return json("""{"id":"$id","mimeType":"$type"}""")
    }

    private fun download(id: String): MockResponse {
        val bytes = media[id] ?: return failure(410, errorAnswer("Gone"))
        downloads++
        return MockResponse.Builder().setHeader("Content-Type", "image/jpeg").body(Buffer().write(bytes)).build()
    }

    @Synchronized
    private fun list(): String = buildJsonObject {
        putJsonArray("conversations") {
            conversations.forEach { conversation ->
                add(
                    buildJsonObject {
                        put("conversationKey", conversation.key)
                        put("kind", conversation.kind)
                        put("revision", conversation.revision)
                        put("rewriteRevision", conversation.rewriteRevision)
                        conversation.title?.let { put("title", it) }
                        conversation.rows.lastOrNull()?.let { put("lastMessage", it.toJson()) }
                    },
                )
            }
        }
    }.toString()

    @Synchronized
    private fun create(): String {
        createdChats++
        val key = "plain:ada:new-$createdChats"
        addChat(key)
        return """{"conversationKey":"$key"}"""
    }

    @Synchronized
    private fun history(key: String, before: String?, after: String?): String {
        val conversation = conversation(key)
        val rows = conversation.rows
        var nextBefore: Long? = null
        var nextAfter: Long? = null
        val page = when {
            after != null -> rows.filter { it.id > after.toLong() }.let { newer ->
                if (newer.size > PAGE) nextAfter = newer[PAGE - 1].id
                newer.take(PAGE)
            }
            else -> rows.filter { before == null || it.id < before.toLong() }.let { older ->
                if (older.size > PAGE) nextBefore = older[older.size - PAGE].id
                older.takeLast(PAGE)
            }
        }
        return buildJsonObject {
            put("revision", conversation.revision)
            put("rewriteRevision", conversation.rewriteRevision)
            put("messages", buildJsonArray { page.forEach { add(it.toJson()) } })
            nextBefore?.let { put("nextBefore", it) }
            nextAfter?.let { put("nextAfter", it) }
        }.toString()
    }

    private fun stream(): MockResponse {
        streamsOpened++
        val body = object : MockResponseBody {
            override val contentLength = -1L

            override fun writeTo(sink: BufferedSink) {
                val events = LinkedBlockingQueue<String>()
                streams.add(events)
                try {
                    sink.writeUtf8("event: check\ndata: {}\n\n").flush()
                    while (!closed) {
                        val event = events.poll(POLL_MILLIS, TimeUnit.MILLISECONDS) ?: continue
                        sink.writeUtf8(event).flush()
                    }
                } catch (_: IOException) {
                    // The client went away.
                } finally {
                    streams.remove(events)
                }
            }
        }
        return MockResponse.Builder().setHeader("Content-Type", "text/event-stream").body(body).build()
    }

    private fun conversation(key: String) = conversations.first { it.key == key }

    private fun Row.toJson() = buildJsonObject {
        put("id", id)
        put("author", author)
        put("kind", "message")
        put("channel", "app")
        put("text", text)
        put("createdAt", createdAt)
        clientMessageId?.let { put("clientMessageId", it) }
        steps?.let { put("steps", Json.parseToJsonElement(it)) }
        if (imageIds.isNotEmpty()) {
            putJsonArray("images") {
                imageIds.forEach { mediaId ->
                    add(
                        buildJsonObject {
                            mediaId?.let { put("mediaId", it) }
                            put("mimeType", "image/jpeg")
                        },
                    )
                }
            }
        }
    }

    private fun json(body: String) = MockResponse.Builder().setHeader("Content-Type", "application/json").body(body).build()

    private fun failure(code: Int, body: String) = MockResponse.Builder().code(code).body(body).build()

    companion object {
        const val BELLA_KEY = "bella:ada"
        const val PAGE = 50
        /** 2026-11-19T12:00:00Z. */
        const val CREATED_AT = 1_795_608_000_000L
        private const val POLL_MILLIS = 20L

        /** The client message id of a send body. */
        fun JsonObject.clientMessageId(): String = getValue("clientMessageId").jsonPrimitive.content
    }
}
