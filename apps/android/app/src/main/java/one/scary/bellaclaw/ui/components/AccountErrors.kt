package one.scary.bellaclaw.ui.components

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LoginLinkProblem
import one.scary.bellaclaw.model.ServerUrlProblem

/** The server's own text when it sent one. */
@Composable
fun AccountError.text(): String = when (this) {
    is AccountError.Server -> message ?: stringResource(R.string.error_server_status, status)
    AccountError.Network -> stringResource(R.string.error_network)
    is AccountError.BadServerUrl -> stringResource(problem.label)
}

@get:StringRes
val ServerUrlProblem.label: Int
    get() = when (this) {
        ServerUrlProblem.EMPTY -> R.string.error_server_url_empty
        ServerUrlProblem.INVALID -> R.string.error_server_url_invalid
        ServerUrlProblem.CLEARTEXT -> R.string.error_server_url_cleartext
    }

@get:StringRes
val LoginLinkProblem.label: Int
    get() = when (this) {
        LoginLinkProblem.NotALoginLink -> R.string.error_link_not_login
        LoginLinkProblem.Incomplete -> R.string.error_link_incomplete
        is LoginLinkProblem.BadServer -> if (problem == ServerUrlProblem.CLEARTEXT) {
            R.string.error_link_cleartext
        } else {
            R.string.error_link_server_invalid
        }
    }
