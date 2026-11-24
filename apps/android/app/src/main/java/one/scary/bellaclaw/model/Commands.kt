package one.scary.bellaclaw.model

/** A command of the server's catalog: its [name] without "!", the [group] it lists under, and its usage line. */
data class CommandEntry(
    val name: String,
    val group: String,
    val description: String,
    val usage: String,
)

private val PLACEHOLDER = Regex("^\\[?[A-Z_]+]?$")

/**
 * The fixed choices for the word right after the command word, merged across the usage's " | " forms in
 * order: `!connector list | !connector approve|reject CONNECTOR` gives list, approve, reject. A form whose
 * next word is missing or a CAPITAL placeholder gives none.
 */
fun usageChoices(entry: CommandEntry): List<String> =
    entry.usage.split(" | ").flatMap { form ->
        val token = form.split(Regex("\\s+")).getOrNull(1)
        if (token == null || PLACEHOLDER.matches(token)) {
            emptyList()
        } else {
            token.split("|")
        }
    }
