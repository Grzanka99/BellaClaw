package one.scary.bellaclaw.model

import java.time.Instant

enum class Author {
    USER,
    ASSISTANT,
}

data class Message(
    val id: String,
    val chatId: String,
    val author: Author,
    val text: String,
    val imageUri: String?,
    val sentAt: Instant,
)
