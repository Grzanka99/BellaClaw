package one.scary.bellaclaw

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.data.local.ChatStore
import one.scary.bellaclaw.data.local.SessionStore
import one.scary.bellaclaw.data.local.ThemeStore
import one.scary.bellaclaw.data.push.FirebasePushTokens
import one.scary.bellaclaw.data.push.PushRepository
import one.scary.bellaclaw.data.push.loadDeviceKeys
import one.scary.bellaclaw.data.remote.ApiClient

/** Creates and holds the app's repositories, one instance each for the whole process. */
class AppContainer(context: Context) {
    /** Lives as long as the process; repositories run work in it that must outlive a screen. */
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val sessionStore = SessionStore(File(context.filesDir, "session.json"))
    private val apiClient = ApiClient(sessionStore)
    private val deviceLock = Mutex()

    /** True while the app is on screen; `MainActivity` reports it. The live stream is open only then. */
    val foreground = MutableStateFlow(false)

    val settingsRepository = SettingsRepository(
        apiClient,
        sessionStore.session,
        ThemeStore(File(context.filesDir, "theme.json")),
        applicationScope,
    )
    val chatRepository = ChatRepository(
        api = apiClient,
        session = sessionStore.session,
        foreground = foreground,
        settings = settingsRepository.settings,
        chatStore = ChatStore(File(context.filesDir, "chats.json")),
        scope = applicationScope,
    )
    val accountRepository = AccountRepository(apiClient, sessionStore, allowCleartext = BuildConfig.DEBUG, deviceLock)
    val pushRepository = PushRepository(
        apiClient,
        sessionStore.session,
        lazy { loadDeviceKeys(File(context.filesDir, "push_auth_secret")) },
        FirebasePushTokens(context),
        deviceLock,
        applicationScope,
    )
}
