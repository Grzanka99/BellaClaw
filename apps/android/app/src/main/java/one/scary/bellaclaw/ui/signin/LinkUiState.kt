package one.scary.bellaclaw.ui.signin

import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LoginLinkProblem

enum class LinkStep {
    /** This screen's link no longer waits (dismissed, used, or lost with the process). */
    MISSING,

    /** The link could not be read; [LinkUiState.problem] says why. */
    UNUSABLE,

    /** Shows the link's server and asks before its token is sent there. */
    CONFIRM,

    /** Signed in on another server than the link's: nothing is sent. */
    OTHER_SERVER,

    /** The server says the link expired or was used. */
    INVALID,

    /** Signed out; the link's chat belongs to [LinkUiState.accountName]: offers to sign in to it. */
    LINKED,

    /** Signed out; the link's chat has no account: create one, or sign in to one, which connects the chat. */
    UNLINKED,

    /** Signed in on the link's server; the chat has no account: offers to connect it to the signed-in one. */
    CONNECT,

    /** Signed in on the link's server; the chat belongs to the signed-in account already. */
    ALREADY_CONNECTED,

    /** Signed in on the link's server; the chat belongs to another account. */
    OTHER_ACCOUNT,

    /** The chat is connected to the signed-in account. */
    CONNECTED,
}

data class LinkUiState(
    val step: LinkStep = LinkStep.MISSING,
    val serverUrl: String = "",
    val problem: LoginLinkProblem? = null,
    /** Once the server answered: the link's chat, e.g. `Signal +48123456789`. */
    val chat: String = "",
    /** LINKED: the chat's account. Every other step past CONFIRM: the signed-in account. */
    val accountName: String = "",
    /** OTHER_SERVER: the server this app is signed in to. */
    val signedInServer: String = "",
    /** UNLINKED: create an account (true) or sign in to one (false). */
    val createAccount: Boolean = true,
    val username: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val error: AccountError? = null,
) {
    val isMissing: Boolean
        get() = step == LinkStep.MISSING

    val canSubmitAccount: Boolean
        get() = !isLoading && username.isNotBlank() && password.isNotEmpty()

    override fun toString() = "LinkUiState(step=$step, serverUrl=$serverUrl, isLoading=$isLoading, error=$error)"
}
