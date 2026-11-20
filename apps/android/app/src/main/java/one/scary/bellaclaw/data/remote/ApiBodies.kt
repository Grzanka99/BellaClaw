package one.scary.bellaclaw.data.remote

import kotlinx.serialization.Serializable

// Request and answer bodies of the gateway's /api routes. Bodies holding a password, a code or a
// token are plain classes, so their toString shows no field.

/** POST /api/login; [token] links the chat of a login link with the login. */
@Serializable
class LoginBody(val username: String, val password: String, val token: String? = null)

/** POST /api/register: a login link of an unlinked chat ([token]) or the activation code. */
@Serializable
class RegisterBody(
    val username: String,
    val password: String,
    val token: String? = null,
    val activationCode: String? = null,
)

/** POST /api/link/check, /api/link/login and /api/link. */
@Serializable
class LinkTokenBody(val token: String)

/** A request with no fields, or an answer whose fields the app does not read. */
@Serializable
object EmptyBody

/** The answer of register, login and link login to the app: the account and its new session's bearer token. */
@Serializable
class AppSessionBody(val username: String, val token: String)

/** The answer of POST /api/link. */
@Serializable
data class AccountBody(val username: String)

/** POST /api/link/check: [username] is present when the link's chat belongs to an account. */
@Serializable
data class LinkCheckBody(val valid: Boolean, val chatKey: String? = null, val username: String? = null)

/** The answer of POST /api/logout and PUT /api/device. */
@Serializable
data class OkBody(val ok: Boolean)

/** Every answer outside 2xx. */
@Serializable
data class ErrorBody(val error: String? = null)
