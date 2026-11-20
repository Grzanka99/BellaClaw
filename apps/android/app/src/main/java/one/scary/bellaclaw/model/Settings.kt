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
    val mode: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = false,
)

/** Settings the server holds: loading until the first answer, then loaded, or why the load failed. */
sealed interface Loadable<out T> {
    data object Loading : Loadable<Nothing>

    data class Loaded<T>(val value: T) : Loadable<T>

    data class Failed(val error: AccountError) : Loadable<Nothing>

    /** The value once loaded, else null. */
    val valueOrNull: T?
        get() = (this as? Loaded)?.value

    fun <R> map(transform: (T) -> R): Loadable<R> = when (this) {
        Loading -> Loading
        is Loaded -> Loaded(transform(value))
        is Failed -> this
    }
}

/**
 * Every setting as one value: the account's [models] and [personality] from the server, the
 * providers and models a plain chat may use ([chatModels]), and the phone's [theme].
 */
data class SettingsSnapshot(
    val models: Loadable<ModelSettings> = Loadable.Loading,
    /** True while the server verifies a change of [models]; no second change starts meanwhile. */
    val isChangingModels: Boolean = false,
    /** Why the server refused the last change of [models]. */
    val modelsChangeError: AccountError? = null,
    val personality: Loadable<Personality> = Loadable.Loading,
    /** Every provider a plain chat may use, in the server's order; a held list stays while it is read again. */
    val chatModels: Loadable<List<ChatProvider>> = Loadable.Loading,
    val theme: ThemeSettings = ThemeSettings(),
)
