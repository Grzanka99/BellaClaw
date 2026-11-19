package one.scary.bellaclaw.data.sample

import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.ModelSettings
import one.scary.bellaclaw.model.Personality
import one.scary.bellaclaw.model.Provider
import one.scary.bellaclaw.model.RoleModel
import one.scary.bellaclaw.model.SettingsSnapshot
import one.scary.bellaclaw.model.ThemeMode
import one.scary.bellaclaw.model.ThemeSettings

/** The settings the app starts with. */
object SampleSettings {
    val providers: List<Provider> = listOf(
        Provider("opencode-go", "OpenCode Go", listOf("Kimi K3.1 Pro", "Claude Haiku 5.5", "GLM 5")),
        Provider("openai-codex", "Codex", listOf("GPT-5.5", "GPT-5.5 Mini", "GPT-5.4 Codex")),
    )

    val roleDefaults: Map<String, Map<ModelRole, RoleModel>> = mapOf(
        "opencode-go" to mapOf(
            ModelRole.UTILITY to RoleModel("Claude Haiku 5.5", Effort.LOW),
            ModelRole.MAIN to RoleModel("Kimi K3.1 Pro", Effort.LOW),
            ModelRole.SPECIALIST to RoleModel("Kimi K3.1 Pro", Effort.LOW),
            ModelRole.SPECIALIST_ACCURATE to RoleModel("Kimi K3.1 Pro", Effort.LOW),
            ModelRole.SCHEDULED_TASK to RoleModel("Kimi K3.1 Pro", Effort.LOW),
        ),
        "openai-codex" to mapOf(
            ModelRole.UTILITY to RoleModel("GPT-5.5 Mini", Effort.LOW),
            ModelRole.MAIN to RoleModel("GPT-5.5", Effort.LOW),
            ModelRole.SPECIALIST to RoleModel("GPT-5.4 Codex", Effort.MEDIUM),
            ModelRole.SPECIALIST_ACCURATE to RoleModel("GPT-5.5", Effort.HIGH),
            ModelRole.SCHEDULED_TASK to RoleModel("GPT-5.5", Effort.LOW),
        ),
    )

    val modelSettings = ModelSettings(
        providerId = "opencode-go",
        roles = roleDefaults.getValue("opencode-go") +
            (ModelRole.SPECIALIST_ACCURATE to RoleModel("Kimi K3.1 Pro", Effort.HIGH)),
        defaults = roleDefaults.getValue("opencode-go"),
    )

    val personality = Personality(
        bellaClaw = "You are BellaClaw, a personal assistant. Be direct, a bit dry, never pad " +
            "answers. Reply in the language I write in.",
        useInChats = true,
        chats = "Keep it short. Code examples in Kotlin.",
    )

    val theme = ThemeSettings(mode = ThemeMode.SYSTEM, dynamicColor = false)

    val settings = SettingsSnapshot(providers, modelSettings, personality, theme)
}
