package one.scary.bellaclaw

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.sync.Mutex
import one.scary.bellaclaw.data.AccountRepository
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.SettingsRepository
import one.scary.bellaclaw.data.local.SessionStore
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

    val chatRepository = ChatRepository(applicationScope)
    val settingsRepository = SettingsRepository()
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
