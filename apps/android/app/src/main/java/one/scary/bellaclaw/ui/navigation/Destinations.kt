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
