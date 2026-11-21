package one.scary.bellaclaw.ui.chat

import one.scary.bellaclaw.model.Message
import java.time.LocalDate
import java.time.ZoneId

/** [messages] (oldest first) as list rows, newest first, with a [ChatRow.Day] above each day's messages in [zone]. */
fun chatRows(messages: List<Message>, zone: ZoneId): List<ChatRow> = buildList {
    var day: LocalDate? = null
    messages.forEach { message ->
        val date = message.sentAt.atZone(zone).toLocalDate()
        if (date != day) {
            day = date
            add(ChatRow.Day(date, message.id))
        }
        add(ChatRow.Item(message))
    }
}.asReversed()
