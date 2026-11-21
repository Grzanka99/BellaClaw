package one.scary.bellaclaw.data.local

import java.io.File
import kotlinx.coroutines.test.runTest
import one.scary.bellaclaw.model.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val session = Session("https://bella.example.com", "ada", "t0")

    private fun file() = File(folder.root, "session.json")

    @Test
    fun `starts signed out with no server`() {
        val store = SessionStore(file())

        assertNull(store.session.value)
        assertNull(store.lastServerUrl)
    }

    @Test
    fun `the session survives a new store on the same file`() = runTest {
        SessionStore(file()).save(session)

        val restarted = SessionStore(file())

        assertEquals(session, restarted.session.value)
        assertEquals("https://bella.example.com", restarted.lastServerUrl)
    }

    @Test
    fun `ending the session keeps the server for the next sign-in`() = runTest {
        val store = SessionStore(file())
        store.save(session)

        store.end("t0")

        assertNull(store.session.value)
        assertEquals("https://bella.example.com", store.lastServerUrl)
        assertNull(SessionStore(file()).session.value)
        assertEquals("https://bella.example.com", SessionStore(file()).lastServerUrl)
    }

    @Test
    fun `the session's text leaves out its token`() {
        assertFalse(session.toString().contains("t0"))
    }
}
