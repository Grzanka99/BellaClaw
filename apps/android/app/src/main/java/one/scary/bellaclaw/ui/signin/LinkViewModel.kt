package one.scary.bellaclaw.ui.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.model.LinkStatus
import one.scary.bellaclaw.model.LinkStatusResult
import one.scary.bellaclaw.model.LoginLink
import one.scary.bellaclaw.model.PendingLink
import one.scary.bellaclaw.model.Session
import one.scary.bellaclaw.ui.appContainer

/**
 * Confirms the login link that waits when this ViewModel is created, and only that one. Nothing is
 * sent with its token before the user confirms its server ([check]), and nothing signs in, registers
 * or connects before the server named the link's chat. Nothing here survives process death: the link
 * is held in memory only, so a restored screen finds no link and closes.
 */
class LinkViewModel(private val accountRepository: AccountRepository) : ViewModel() {
    private val link: PendingLink? = accountRepository.pendingLink.value
    private val usableLink: LoginLink? = when (link) {
        is PendingLink.Usable -> link.link
        is PendingLink.Unusable, null -> null
    }
    private val progress = MutableStateFlow(Progress())

    val uiState: StateFlow<LinkUiState> = combine(
        accountRepository.pendingLink,
        accountRepository.session,
        progress,
        ::state,
    ).stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(5_000),
        state(accountRepository.pendingLink.value, accountRepository.session.value, progress.value),
    )

    /** The user trusts the shown server, so the link is checked there. */
    fun check() {
        if (uiState.value.step != LinkStep.CONFIRM) {
            return
        }
        val link = startRequest() ?: return
        viewModelScope.launch {
            when (val result = accountRepository.linkStatus(link)) {
                is LinkStatusResult.Known -> progress.update { it.copy(isLoading = false, status = result.status) }
                is LinkStatusResult.Failed -> progress.update { it.copy(isLoading = false, error = result.error) }
            }
        }
    }

    /** Signs in to the account the link's chat belongs to. A success drops the link, which closes the screen. */
    fun signInLinked() {
        if (uiState.value.step != LinkStep.LINKED) {
            return
        }
        val link = startRequest() ?: return
        viewModelScope.launch { finish(accountRepository.signInWithLink(link)) }
    }

    fun onCreateAccountChange(createAccount: Boolean) {
        progress.update { it.copy(createAccount = createAccount, error = null) }
    }

    fun onUsernameChange(text: String) {
        progress.update { it.copy(username = text, error = null) }
    }

    fun onPasswordChange(text: String) {
        progress.update { it.copy(password = text, error = null) }
    }

    /** For a chat with no account: creates one, or signs in to one; either connects the chat. */
    fun submitAccount() {
        if (uiState.value.step != LinkStep.UNLINKED || !uiState.value.canSubmitAccount) {
            return
        }
        val link = startRequest() ?: return
        val current = progress.value
        val username = current.username.trim()
        viewModelScope.launch {
            val error = if (current.createAccount) {
                accountRepository.registerWithLink(link, username, current.password)
            } else {
                accountRepository.signInAndLink(link, username, current.password)
            }
            finish(error)
        }
    }

    /** Signed in on the link's server: connects its chat to the account. */
    fun connect() {
        if (uiState.value.step != LinkStep.CONNECT) {
            return
        }
        val link = startRequest() ?: return
        viewModelScope.launch {
            val error = accountRepository.linkToAccount(link)
            progress.update { it.copy(isLoading = false, error = error, connected = error == null) }
        }
    }

    /** Drops this screen's link; the screen then closes. */
    fun dismiss() {
        if (link != null) {
            accountRepository.dismissLink(link)
        }
    }

    private fun state(pending: PendingLink?, session: Session?, progress: Progress): LinkUiState {
        if (pending == null || pending != link) {
            return LinkUiState()
        }
        return when (pending) {
            is PendingLink.Unusable -> LinkUiState(step = LinkStep.UNUSABLE, problem = pending.problem)
            is PendingLink.Usable -> usableState(pending.link, session, progress)
        }
    }

    private fun usableState(link: LoginLink, session: Session?, progress: Progress): LinkUiState {
        val base = LinkUiState(
            serverUrl = link.serverUrl,
            accountName = session?.username.orEmpty(),
            createAccount = progress.createAccount,
            username = progress.username,
            password = progress.password,
            isLoading = progress.isLoading,
            error = progress.error,
        )
        if (session != null && session.serverUrl != link.serverUrl) {
            return base.copy(step = LinkStep.OTHER_SERVER, signedInServer = session.serverUrl)
        }
        return when (val status = progress.status) {
            null -> base.copy(step = LinkStep.CONFIRM)
            LinkStatus.Invalid -> base.copy(step = LinkStep.INVALID)
            is LinkStatus.Linked -> when {
                session == null -> base.copy(step = LinkStep.LINKED, chat = status.chat, accountName = status.username)
                session.username == status.username -> base.copy(step = LinkStep.ALREADY_CONNECTED, chat = status.chat)
                else -> base.copy(step = LinkStep.OTHER_ACCOUNT, chat = status.chat)
            }
            is LinkStatus.Unlinked -> when {
                session == null -> base.copy(step = LinkStep.UNLINKED, chat = status.chat)
                progress.connected -> base.copy(step = LinkStep.CONNECTED, chat = status.chat)
                else -> base.copy(step = LinkStep.CONNECT, chat = status.chat)
            }
        }
    }

    /** The link a request goes out for, marked loading; null while one runs. */
    private fun startRequest(): LoginLink? {
        if (usableLink == null || progress.value.isLoading) {
            return null
        }
        progress.update { it.copy(isLoading = true, error = null) }
        return usableLink
    }

    private fun finish(error: AccountError?) {
        progress.update { it.copy(isLoading = false, error = error) }
    }

    /** What happened with this screen's link. [toString] leaves out the password. */
    private data class Progress(
        val status: LinkStatus? = null,
        val createAccount: Boolean = true,
        val username: String = "",
        val password: String = "",
        val isLoading: Boolean = false,
        val error: AccountError? = null,
        val connected: Boolean = false,
    ) {
        override fun toString() = "Progress(status=$status, isLoading=$isLoading, error=$error)"
    }

    companion object {
        val Factory = viewModelFactory {
            initializer { LinkViewModel(appContainer().accountRepository) }
        }
    }
}
