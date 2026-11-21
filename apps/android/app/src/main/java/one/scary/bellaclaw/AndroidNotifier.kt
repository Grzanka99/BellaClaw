package one.scary.bellaclaw

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import one.scary.bellaclaw.data.push.Notifier
import one.scary.bellaclaw.model.BELLACLAW_CHAT_ID
import one.scary.bellaclaw.model.ChatNotification
import one.scary.bellaclaw.ui.MainActivity
import one.scary.bellaclaw.ui.components.styledText

/**
 * The notifications in Android: one per conversation, tagged with its key, on the BellaClaw channel or
 * the chats channel, each of which the person can switch off in Android's settings. Tapping one opens
 * its chat. Without the notification permission nothing shows.
 */
class AndroidNotifier(private val context: Context) : Notifier {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(BELLACLAW_CHANNEL, context.getString(R.string.channel_bellaclaw), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(CHATS_CHANNEL, context.getString(R.string.channel_chats), NotificationManager.IMPORTANCE_HIGH),
            ),
        )
    }

    override fun show(notification: ChatNotification, alert: Boolean) {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return
        }
        val isBellaClaw = notification.chatId == BELLACLAW_CHAT_ID
        val title = if (isBellaClaw) {
            context.getString(R.string.bellaclaw_name)
        } else {
            notification.title ?: context.getString(R.string.new_chat_title)
        }
        val text = styledText(notification.text).text
        val channel = if (isBellaClaw) BELLACLAW_CHANNEL else CHATS_CHANNEL
        val open = Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_CHAT_ID, notification.chatId)
        val tap = PendingIntent.getActivity(
            context,
            notification.conversationKey.hashCode(),
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val shown = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .build()
        manager.notify(notification.conversationKey, ID, shown)
    }

    override fun cancel(conversationKey: String) {
        manager.cancel(conversationKey, ID)
    }

    override fun cancelAll() {
        manager.cancelAll()
    }

    private companion object {
        const val BELLACLAW_CHANNEL = "bellaclaw"
        const val CHATS_CHANNEL = "chats"

        /** Every notification has this id; its tag, the conversation key, tells them apart. */
        const val ID = 1
    }
}
