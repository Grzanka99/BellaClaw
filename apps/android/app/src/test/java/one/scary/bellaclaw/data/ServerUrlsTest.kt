package one.scary.bellaclaw.data

import one.scary.bellaclaw.model.LoginLink
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.model.ServerUrlProblem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ServerUrlsTest {
    @Test
    fun `accepts https and normalises it`() {
        assertEquals(ServerUrlCheck.Valid("https://bella.example.com"), checkServerUrl("  https://bella.example.com/  ", false))
        assertEquals(ServerUrlCheck.Valid("https://bella.example.com"), checkServerUrl("HTTPS://Bella.Example.COM", false))
        assertEquals(ServerUrlCheck.Valid("https://bella.example.com:8443/app"), checkServerUrl("https://bella.example.com:8443/app//", false))
    }

    @Test
    fun `drops a default port`() {
        assertEquals(ServerUrlCheck.Valid("https://bella.example.com"), checkServerUrl("https://bella.example.com:443", false))
        assertEquals(ServerUrlCheck.Valid("http://bella.example.com"), checkServerUrl("http://bella.example.com:80/", true))
        assertEquals(ServerUrlCheck.Valid("https://bella.example.com:80"), checkServerUrl("https://bella.example.com:80", false))
    }

    @Test
    fun `accepts http only when cleartext is allowed`() {
        assertEquals(ServerUrlCheck.Invalid(ServerUrlProblem.CLEARTEXT), checkServerUrl("http://10.0.2.2:8988", false))
        assertEquals(ServerUrlCheck.Valid("http://10.0.2.2:8988"), checkServerUrl("http://10.0.2.2:8988/", true))
    }

    @Test
    fun `refuses what is not an absolute http address`() {
        assertEquals(ServerUrlCheck.Invalid(ServerUrlProblem.EMPTY), checkServerUrl("   ", true))
        listOf(
            "bella.example.com",
            "ftp://bella.example.com",
            "https://",
            "https://user:secret@bella.example.com",
            "https://bella.example.com/?a=1",
            "https://bella.example.com/#top",
            "https://bella example.com",
            "https://bella.example.com:0",
            "https://bella.example.com:65536",
            "/api",
        ).forEach { input ->
            assertEquals(input, ServerUrlCheck.Invalid(ServerUrlProblem.INVALID), checkServerUrl(input, true))
        }
    }

    @Test
    fun `reads a login link and its pasted code`() {
        val expected = LoginLinkCheck.Valid(LoginLink("https://bella.example.com", "abc.DEF-_1"))
        val link = "bellaclaw://login?server=https%3A%2F%2Fbella.example.com&token=abc.DEF-_1"
        assertEquals(expected, parseLoginLink(link, false))
        assertEquals(expected, parseLoginLink("  $link\n", false))
        assertEquals(expected, parseLoginLink("bellaclaw://login?token=abc.DEF-_1&server=https://bella.example.com/", false))
    }

    @Test
    fun `refuses another scheme or host`() {
        listOf(
            "https://login?server=https%3A%2F%2Fbella.example.com&token=t",
            "bellaclaw://link?server=https%3A%2F%2Fbella.example.com&token=t",
            "bella claw",
            "bellaclaw://login?server=%zz&token=t",
        ).forEach { input ->
            assertEquals(input, LoginLinkCheck.Invalid(LoginLinkProblem.NotALoginLink), parseLoginLink(input, false))
        }
    }

    @Test
    fun `refuses a link with a missing part`() {
        listOf(
            "bellaclaw://login",
            "bellaclaw://login?server=https%3A%2F%2Fbella.example.com",
            "bellaclaw://login?token=t",
            "bellaclaw://login?server=&token=t",
            "bellaclaw://login?server=https%3A%2F%2Fbella.example.com&token=",
        ).forEach { input ->
            assertEquals(input, LoginLinkCheck.Invalid(LoginLinkProblem.Incomplete), parseLoginLink(input, false))
        }
    }

    @Test
    fun `refuses a link whose server breaks the address rule`() {
        val cleartext = "bellaclaw://login?server=http%3A%2F%2Fbella.example.com&token=t"
        assertEquals(LoginLinkCheck.Invalid(LoginLinkProblem.BadServer(ServerUrlProblem.CLEARTEXT)), parseLoginLink(cleartext, false))
        assertEquals(LoginLinkCheck.Valid(LoginLink("http://bella.example.com", "t")), parseLoginLink(cleartext, true))
        assertEquals(
            LoginLinkCheck.Invalid(LoginLinkProblem.BadServer(ServerUrlProblem.INVALID)),
            parseLoginLink("bellaclaw://login?server=javascript%3Aalert(1)&token=t", true),
        )
    }

    @Test
    fun `a login link's text leaves out its token`() {
        assertFalse(LoginLink("https://bella.example.com", "secret-token").toString().contains("secret-token"))
    }
}
