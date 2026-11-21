package one.scary.bellaclaw.model

/** A signed-in account on one server. [toString] leaves out the token. */
data class Session(
    val serverUrl: String,
    val username: String,
    val token: String,
) {
    override fun toString() = "Session(serverUrl=$serverUrl, username=$username)"
}

/** Why a server address is refused. */
enum class ServerUrlProblem {
    EMPTY,

    /** Not an absolute http(s) address, or one with credentials, a query or a fragment. */
    INVALID,

    /** `http://` outside a debug build. */
    CLEARTEXT,
}

/** A `bellaclaw://login` link from a chat: the server it names and its one-use token. [toString] leaves out the token. */
data class LoginLink(
    val serverUrl: String,
    val token: String,
) {
    override fun toString() = "LoginLink(serverUrl=$serverUrl)"
}

sealed interface LoginLinkProblem {
    /** Not a `bellaclaw://login` link. */
    data object NotALoginLink : LoginLinkProblem

    /** The server or the token is missing. */
    data object Incomplete : LoginLinkProblem

    data class BadServer(val problem: ServerUrlProblem) : LoginLinkProblem
}

/** A login link waiting for the user's confirmation: one that parsed, or why it did not. */
sealed interface PendingLink {
    data class Usable(val link: LoginLink) : PendingLink

    data class Unusable(val problem: LoginLinkProblem) : PendingLink
}

/** What the server says a login link is. [chat] is the link's chat as its channel and address, e.g. `Signal +48123456789`. */
sealed interface LinkStatus {
    /** Unknown, expired or used. */
    data object Invalid : LinkStatus

    /** Its chat belongs to the account [username] already. */
    data class Linked(val chat: String, val username: String) : LinkStatus

    /** Its chat has no account yet. */
    data class Unlinked(val chat: String) : LinkStatus
}

sealed interface LinkStatusResult {
    data class Known(val status: LinkStatus) : LinkStatusResult

    data class Failed(val error: AccountError) : LinkStatusResult
}

/** Why an account request failed. */
sealed interface AccountError {
    /** The server refused it; [message] is the server's `error` text, null when the answer had none. */
    data class Server(val status: Int, val message: String?) : AccountError

    /** The server could not be reached. */
    data object Network : AccountError

    data class BadServerUrl(val problem: ServerUrlProblem) : AccountError
}
