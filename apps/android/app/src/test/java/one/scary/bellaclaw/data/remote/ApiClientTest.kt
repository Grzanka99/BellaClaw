package one.scary.bellaclaw.data.remote

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.json
import one.scary.bellaclaw.data.sessionAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class ApiClientTest {
    @get:Rule
    val gateway = TestServer()

    @Test
    fun `a request without a session carries the client header, a JSON body with its length and no bearer`() = runTest {
        val client = ApiClient(gateway.store())
        gateway.answer(200, sessionAnswer("ada", "t1"))

        val result = client.post<LoginBody, AppSessionBody>(gateway.url, "/api/login", LoginBody("ada", "pw"))

        val success = result as ApiResult.Success
        assertEquals("ada", success.value.username)
        assertEquals("t1", success.value.token)
        val request = gateway.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/login", request.url.encodedPath)
        assertEquals("app", request.headers["X-BellaClaw-Client"])
        assertNull(request.headers["Authorization"])
        assertEquals(request.bodySize.toString(), request.headers["Content-Length"])
        assertEquals("application/json; charset=utf-8", request.headers["Content-Type"])
        assertEquals("ada", request.json()["username"]?.jsonPrimitive?.content)
        assertFalse("null fields are left out", request.json().containsKey("token"))
    }

    @Test
    fun `a signed-in request goes to the session's server with its bearer token and the client header`() = runTest {
        val client = ApiClient(gateway.signedInStore())
        gateway.answer(200, """{"username":"ada","chats":[]}""")

        val result = client.postSignedIn<LinkTokenBody, AccountBody>("/api/link", LinkTokenBody("link"))

        assertEquals(ApiResult.Success(AccountBody("ada")), result)
        val request = gateway.takeRequest()
        assertEquals("/api/link", request.url.encodedPath)
        assertEquals("Bearer t0", request.headers["Authorization"])
        assertEquals("app", request.headers["X-BellaClaw-Client"])
        assertEquals(request.bodySize.toString(), request.headers["Content-Length"])
    }

    @Test
    fun `an answer outside 2xx is an API error with the server's text`() = runTest {
        val client = ApiClient(gateway.store())
        gateway.answer(409, errorAnswer("This username is taken"))

        val result = client.post<RegisterBody, AppSessionBody>(gateway.url, "/api/register", RegisterBody("ada", "pw", activationCode = "c"))

        assertEquals(ApiResult.ApiError(409, "This username is taken"), result)
    }

    @Test
    fun `an error answer that is not the server's JSON has no text`() = runTest {
        val client = ApiClient(gateway.store())
        gateway.answer(502, "<html>Bad gateway</html>")

        val result = client.post<LinkTokenBody, LinkCheckBody>(gateway.url, "/api/link/check", LinkTokenBody("t"))

        assertEquals(ApiResult.ApiError(502, null), result)
    }

    @Test
    fun `a success the client cannot read is an API error`() = runTest {
        val client = ApiClient(gateway.store())
        gateway.answer(200, "{}")

        val result = client.post<LinkTokenBody, LinkCheckBody>(gateway.url, "/api/link/check", LinkTokenBody("t"))

        assertEquals(ApiResult.ApiError(200, null), result)
    }

    @Test
    fun `an unreachable server is a network failure`() = runTest {
        val client = ApiClient(gateway.store())
        val url = gateway.url
        gateway.server.close()

        val result = client.post<LinkTokenBody, LinkCheckBody>(url, "/api/link/check", LinkTokenBody("t"))

        assertEquals(ApiResult.NetworkFailure, result)
    }

    @Test
    fun `a 401 on a signed-in request ends the session and keeps the server`() = runTest {
        val store = gateway.signedInStore()
        val client = ApiClient(store)
        gateway.answer(401, errorAnswer("Unauthorized"))

        val result = client.postSignedIn<LinkTokenBody, AccountBody>("/api/link", LinkTokenBody("t"))

        assertEquals(ApiResult.ApiError(401, "Unauthorized"), result)
        assertNull(store.session.value)
        assertEquals(gateway.url, store.lastServerUrl)
    }

    @Test
    fun `a redirect answer is an API error and is not followed`() = runTest {
        val client = ApiClient(gateway.store())
        gateway.server.enqueue(MockResponse.Builder().code(307).addHeader("Location", gateway.server.url("/elsewhere")).build())

        val result = client.post<LoginBody, AppSessionBody>(gateway.url, "/api/login", LoginBody("ada", "pw"))

        assertEquals(ApiResult.ApiError(307, null), result)
        assertEquals(1, gateway.server.requestCount)
    }
}
