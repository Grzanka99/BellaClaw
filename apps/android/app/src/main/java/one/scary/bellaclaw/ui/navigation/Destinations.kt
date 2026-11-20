package one.scary.bellaclaw.ui.navigation

import kotlinx.serialization.Serializable

@Serializable
data object HomeDestination

@Serializable
data class ChatDestination(val chatId: String)

@Serializable
data object SettingsDestination

@Serializable
data object ModelSettingsDestination

@Serializable
data object PersonalityDestination

@Serializable
data object ThemeDestination

@Serializable
data object SignInDestination

/** [serverUrl]: the address typed on the sign-in screen, to start from. */
@Serializable
data class RegisterDestination(val serverUrl: String)

/** The confirmation of the pending login link, which the account repository holds. */
@Serializable
data object LinkDestination
