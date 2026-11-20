package one.scary.bellaclaw.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.data.remote.AccountBody
import one.scary.bellaclaw.data.remote.ApiClient
import one.scary.bellaclaw.data.remote.ApiResult
import one.scary.bellaclaw.data.remote.AppSessionBody
import one.scary.bellaclaw.data.remote.EmptyBody
import one.scary.bellaclaw.data.remote.LinkCheckBody
import one.scary.bellaclaw.data.remote.LinkTokenBody
import one.scary.bellaclaw.data.remote.LoginBody
import one.scary.bellaclaw.data.remote.OkBody
import one.scary.bellaclaw.data.remote.RegisterBody
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LinkStatus
import one.scary.bellaclaw.model.LinkStatusResult
import one.scary.bellaclaw.model.LoginLink
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.model.PendingLink
import one.scary.bellaclaw.model.Session

/**
 * The account on one server: the session, sign-in, sign-out and login links. Server addresses follow
 * [checkServerUrl]; `http://` only when [allowCleartext]. Each `suspend` call answers null on success
 * or why it failed. Sign-out holds [deviceLock], so the device does not register while it runs.
 */
class AccountRepository(
    private val api: ApiClient,
    private val sessionStore: SessionStore,
    private val allowCleartext: Boolean,
    private val deviceLock: Mutex,
) {
    private val pending = MutableStateFlow<PendingLink?>(null)

    val session: StateFlow<Session?> = sessionStore.session

    /** The server of the current or the last session. */
    val lastServerUrl: String?
        get() = sessionStore.lastServerUrl

    /**
     * The login link the user opened or pasted, until they dismiss it or it starts a session. Kept in
     * memory only. One link at a time: a link that arrives while one waits is dropped.
     */
    val pendingLink: StateFlow<PendingLink?> = pending.asStateFlow()

    /** Holds the deep link [text] for confirmation, usable or not; nothing is sent. */
    fun openLink(text: String) {
        when (val check = parseLoginLink(text, allowCleartext)) {
            is LoginLinkCheck.Valid -> hold(PendingLink.Usable(check.link))
            is LoginLinkCheck.Invalid -> hold(PendingLink.Unusable(check.problem))
        }
    }

    /** Holds the pasted code [text] for confirmation when it is a usable link; nothing is sent. Answers why it is not. */
    fun openCode(text: String): LoginLinkProblem? {
        when (val check = parseLoginLink(text, allowCleartext)) {
            is LoginLinkCheck.Valid -> {
                hold(PendingLink.Usable(check.link))
                return null
            }
            is LoginLinkCheck.Invalid -> return check.problem
        }
    }

    /** Drops [link] if it is the one waiting. */
    fun dismissLink(link: PendingLink) {
        pending.compareAndSet(link, null)
    }

    suspend fun signIn(serverInput: String, username: String, password: String): AccountError? {
        val url = when (val server = checkServerUrl(serverInput, allowCleartext)) {
            is ServerUrlCheck.Valid -> server.url
            is ServerUrlCheck.Invalid -> return AccountError.BadServerUrl(server.problem)
        }
        return startSession(url, api.post(url, "/api/login", LoginBody(username, password)))
    }

    suspend fun register(serverInput: String, username: String, password: String, activationCode: String): AccountError? {
        val url = when (val server = checkServerUrl(serverInput, allowCleartext)) {
            is ServerUrlCheck.Valid -> server.url
            is ServerUrlCheck.Invalid -> return AccountError.BadServerUrl(server.problem)
        }
        val body = RegisterBody(username, password, activationCode = activationCode)
        return startSession(url, api.post(url, "/api/register", body))
    }

    /** Asks the link's server what [link] is. Sends its token; call only once the user confirmed the server. */
    suspend fun linkStatus(link: LoginLink): LinkStatusResult {
        val result = api.post<LinkTokenBody, LinkCheckBody>(link.serverUrl, "/api/link/check", LinkTokenBody(link.token))
        val body = when (result) {
            is ApiResult.Success -> result.value
            is ApiResult.ApiError -> return LinkStatusResult.Failed(AccountError.Server(result.status, result.message))
            ApiResult.NetworkFailure -> return LinkStatusResult.Failed(AccountError.Network)
        }
        if (!body.valid) {
            return LinkStatusResult.Known(LinkStatus.Invalid)
        }
        // A valid link always names its chat; an answer without one is one the app cannot read.
        val chatKey = body.chatKey ?: return LinkStatusResult.Failed(AccountError.Server(OK, null))
        // `signal:+48123456789` reads `Signal +48123456789`.
        val chat = chatKey.replaceFirst(':', ' ').replaceFirstChar { it.uppercase() }
        if (body.username != null) {
            return LinkStatusResult.Known(LinkStatus.Linked(chat, body.username))
        }
        return LinkStatusResult.Known(LinkStatus.Unlinked(chat))
    }

    /** Signs in to the account [link]'s chat belongs to. */
    suspend fun signInWithLink(link: LoginLink): AccountError? =
        startSession(link.serverUrl, api.post(link.serverUrl, "/api/link/login", LinkTokenBody(link.token)), link)

    /** Creates an account on [link]'s server and links its chat to it. */
    suspend fun registerWithLink(link: LoginLink, username: String, password: String): AccountError? =
        startSession(link.serverUrl, api.post(link.serverUrl, "/api/register", RegisterBody(username, password, token = link.token)), link)

    /** Signs in to an existing account on [link]'s server and links its chat to it. */
    suspend fun signInAndLink(link: LoginLink, username: String, password: String): AccountError? =
        startSession(link.serverUrl, api.post(link.serverUrl, "/api/login", LoginBody(username, password, link.token)), link)

    /** Links [link]'s chat to the signed-in account; [link] must name the session's server. The link stays pending until dismissed. */
    suspend fun linkToAccount(link: LoginLink): AccountError? {
        return api.postSignedIn<LinkTokenBody, AccountBody>("/api/link", LinkTokenBody(link.token)).toError()
    }

    /** Ends the session on the server, then here. A `401` ends it here too; any other failure keeps it. */
    suspend fun signOut(): AccountError? = deviceLock.withLock {
        val session = sessionStore.session.value ?: return null
        val result = api.postSignedIn<EmptyBody, OkBody>("/api/logout", EmptyBody)
        if (result is ApiResult.Success) {
            sessionStore.end(session.token)
        }
        return result.toError()
    }

    /** A session started with [link] drops it, if it still waits. */
    private suspend fun startSession(serverUrl: String, result: ApiResult<AppSessionBody>, link: LoginLink? = null): AccountError? {
        if (result is ApiResult.Success) {
            sessionStore.save(Session(serverUrl, result.value.username, result.value.token))
            if (link != null) {
                pending.compareAndSet(PendingLink.Usable(link), null)
            }
        }
        return result.toError()
    }

    private fun hold(link: PendingLink) {
        pending.compareAndSet(null, link)
    }

    private fun ApiResult<*>.toError(): AccountError? = when (this) {
        is ApiResult.Success -> null
        is ApiResult.ApiError -> AccountError.Server(status, message)
        ApiResult.NetworkFailure -> AccountError.Network
    }

    private companion object {
        const val OK = 200
    }
}
