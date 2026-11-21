package one.scary.bellaclaw.model

/**
 * A new message, as a push brings it: the row [messageId] of conversation [conversationKey]. [kind] is the
 * conversation's kind as the list names it (`bella`, else a plain chat). [text] is the row's text, cut short
 * when the whole push would be over the server's push size limit.
 */
data class AppPush(
    val conversationKey: String,
    val kind: String,
    val messageId: Long,
    val text: String,
)

/**
 * What a notification of conversation [conversationKey] shows: the chat [chatId] it opens, the plain
 * chat's [title] (null for the BellaClaw chat, a new chat, or while the list has not named it), and the
 * message's [text].
 */
data class ChatNotification(
    val conversationKey: String,
    val chatId: String,
    val title: String?,
    val text: String,
)
