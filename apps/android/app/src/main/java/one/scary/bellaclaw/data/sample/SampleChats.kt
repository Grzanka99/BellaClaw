package one.scary.bellaclaw.data.sample

import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.BellaClawChat
import one.scary.bellaclaw.model.Chat
import one.scary.bellaclaw.model.ChatIcon
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.ModelChoice
import one.scary.bellaclaw.model.PlainChat
import java.time.Duration
import java.time.Instant

/** The chats and messages the app starts with. */
object SampleChats {
    val defaultModel = ModelChoice(providerId = "opencode-go", model = "Kimi K3.1 Pro", effort = Effort.LOW)

    val chats: List<Chat> = listOf(
        BellaClawChat,
        PlainChat("kotlin-flow", "Kotlin flow vs channel", ChatIcon.CODE, defaultModel),
        PlainChat("regex", "Regex for Polish postcodes", ChatIcon.FILTER, defaultModel),
        PlainChat("sourdough", "Sourdough hydration", ChatIcon.BAKERY, defaultModel),
        PlainChat(
            "bloom",
            "Explain Bloom filters",
            ChatIcon.SCIENCE,
            ModelChoice("openai-codex", "GPT-5.5", Effort.MEDIUM),
        ),
        PlainChat("translate", "Translate lease clause", ChatIcon.TRANSLATE, defaultModel),
    )

    fun messages(now: Instant): List<Message> {
        fun ago(minutes: Long): Instant = now.minus(Duration.ofMinutes(minutes))
        fun msg(chatId: String, n: Int, author: Author, text: String, minutesAgo: Long) =
            Message("$chatId-$n", chatId, author, text, null, ago(minutesAgo))
        return listOf(
            msg(BELLACLAW_CHAT_ID, 1, Author.ASSISTANT, "Staging is live at staging.app.dev. Smoke tests passed.", 4),
            msg(BELLACLAW_CHAT_ID, 2, Author.USER, "Ship to prod tomorrow 9:00", 3),
            msg(BELLACLAW_CHAT_ID, 3, Author.USER, "And remind me to call mom at 18", 2),
            msg(BELLACLAW_CHAT_ID, 4, Author.ASSISTANT, "Reminder set for 18:00.", 1),
            msg("kotlin-flow", 1, Author.USER, "When should I use Channel instead of SharedFlow?", 30),
            msg(
                "kotlin-flow",
                2,
                Author.ASSISTANT,
                "Use a Channel when each event must be handled exactly once by one consumer, e.g. " +
                    "one-shot UI events.\n\nUse a SharedFlow when several collectors should get the same " +
                    "events, or you need replay.",
                29,
            ),
            msg("kotlin-flow", 3, Author.USER, "And for navigation events?", 28),
            msg(
                "kotlin-flow",
                4,
                Author.ASSISTANT,
                "Channel + receiveAsFlow(), so a rotation doesn't fire the event twice.",
                27,
            ),
            msg("regex", 1, Author.USER, "Regex for a Polish postcode?", 160),
            msg("regex", 2, Author.ASSISTANT, "^\\d{2}-\\d{3}$", 159),
            msg("sourdough", 1, Author.USER, "What hydration should I start with?", 60 * 24 * 3),
            msg("sourdough", 2, Author.ASSISTANT, "75% is a good start for a first loaf.", 60 * 24 * 3 - 1),
            msg("bloom", 1, Author.USER, "Explain Bloom filters", 60 * 24 * 3 + 30),
            msg("bloom", 2, Author.ASSISTANT, "A probabilistic set: it can say \"maybe\" or \"no\", never a false no.", 60 * 24 * 3 + 29),
            msg("translate", 1, Author.USER, "Translate: \"The tenant shall keep the premises in good repair.\"", 60 * 24 * 5),
            msg("translate", 2, Author.ASSISTANT, "\"Najemca utrzymuje lokal w należytym stanie.\"", 60 * 24 * 5 - 1),
        )
    }
}
