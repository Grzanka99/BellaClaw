package one.scary.bellaclaw.data

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import one.scary.bellaclaw.model.LoginLink
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.model.ServerUrlProblem

sealed interface ServerUrlCheck {
    data class Valid(val url: String) : ServerUrlCheck

    data class Invalid(val problem: ServerUrlProblem) : ServerUrlCheck
}

sealed interface LoginLinkCheck {
    data class Valid(val link: LoginLink) : LoginLinkCheck

    data class Invalid(val problem: LoginLinkProblem) : LoginLinkCheck
}

/**
 * Trims [input] and checks it is an absolute `https://` address (`http://` only when [allowCleartext]),
 * with no credentials, query or fragment, and a port, if any, in 1–65535. The result has a lowercase scheme
 * and host, no default port (443 for https, 80 for http) and no trailing slash.
 */
fun checkServerUrl(input: String, allowCleartext: Boolean): ServerUrlCheck {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) {
        return ServerUrlCheck.Invalid(ServerUrlProblem.EMPTY)
    }
    val uri = try {
        URI(trimmed)
    } catch (_: URISyntaxException) {
        return ServerUrlCheck.Invalid(ServerUrlProblem.INVALID)
    }
    val scheme = uri.scheme?.lowercase()
    val host = uri.host
    if (
        (scheme != "https" && scheme != "http") ||
        host.isNullOrEmpty() ||
        uri.rawUserInfo != null ||
        uri.rawQuery != null ||
        uri.rawFragment != null ||
        uri.port == 0 ||
        uri.port > MAX_PORT
    ) {
        return ServerUrlCheck.Invalid(ServerUrlProblem.INVALID)
    }
    if (scheme == "http" && !allowCleartext) {
        return ServerUrlCheck.Invalid(ServerUrlProblem.CLEARTEXT)
    }
    val isDefaultPort = (scheme == "https" && uri.port == HTTPS_PORT) || (scheme == "http" && uri.port == HTTP_PORT)
    val port = if (uri.port == -1 || isDefaultPort) "" else ":${uri.port}"
    val path = uri.rawPath.orEmpty().trimEnd('/')
    return ServerUrlCheck.Valid("$scheme://${host.lowercase()}$port$path")
}

/** Reads `bellaclaw://login?server=<url>&token=<token>`, as a deep link or a pasted code; the server follows [checkServerUrl]. */
fun parseLoginLink(text: String, allowCleartext: Boolean): LoginLinkCheck {
    val uri = try {
        URI(text.trim())
    } catch (_: URISyntaxException) {
        return LoginLinkCheck.Invalid(LoginLinkProblem.NotALoginLink)
    }
    if (!uri.scheme.equals("bellaclaw", ignoreCase = true) || !uri.host.equals("login", ignoreCase = true)) {
        return LoginLinkCheck.Invalid(LoginLinkProblem.NotALoginLink)
    }
    val parameters = try {
        uri.rawQuery.orEmpty()
            .split('&')
            .mapNotNull { pair ->
                val parts = pair.split('=', limit = 2)
                if (parts.size == 2) {
                    parts[0] to URLDecoder.decode(parts[1], Charsets.UTF_8)
                } else {
                    null
                }
            }
            .toMap()
    } catch (_: IllegalArgumentException) {
        // A malformed %-escape.
        return LoginLinkCheck.Invalid(LoginLinkProblem.NotALoginLink)
    }
    val server = parameters["server"]
    val token = parameters["token"]
    if (server.isNullOrBlank() || token.isNullOrBlank()) {
        return LoginLinkCheck.Invalid(LoginLinkProblem.Incomplete)
    }
    return when (val serverCheck = checkServerUrl(server, allowCleartext)) {
        is ServerUrlCheck.Valid -> LoginLinkCheck.Valid(LoginLink(serverCheck.url, token))
        is ServerUrlCheck.Invalid -> LoginLinkCheck.Invalid(LoginLinkProblem.BadServer(serverCheck.problem))
    }
}

private const val MAX_PORT = 65535
private const val HTTPS_PORT = 443
private const val HTTP_PORT = 80
