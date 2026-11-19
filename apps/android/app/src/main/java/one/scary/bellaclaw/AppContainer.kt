package one.scary.bellaclaw

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import one.scary.bellaclaw.data.ChatRepository
import one.scary.bellaclaw.data.SettingsRepository

/** Creates and holds the app's repositories, one instance each for the whole process. */
class AppContainer {
    /** Lives as long as the process; repositories run work in it that must outlive a screen. */
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val chatRepository = ChatRepository(applicationScope)
    val settingsRepository = SettingsRepository()
}
