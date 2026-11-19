package one.scary.bellaclaw.model

/** Serializable so a screen can keep an unsaved draft across process death. */
data class Personality(
    val bellaClaw: String,
    val useInChats: Boolean,
    val chats: String,
) : java.io.Serializable

enum class ThemeMode {
    SYSTEM,
    LIGHT,
    DARK,
}

data class ThemeSettings(
    val mode: ThemeMode,
    val dynamicColor: Boolean,
)

/**
 * Every setting as one value. [providers] always holds the provider [models] selects; the settings
 * repository keeps it so on every change.
 */
data class SettingsSnapshot(
    val providers: List<Provider>,
    val models: ModelSettings,
    val personality: Personality,
    val theme: ThemeSettings,
) {
    val provider: Provider
        get() = providers.first { it.id == models.providerId }
}
