package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.FinishedList
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.ui.components.formatTime
import one.scary.bellaclaw.ui.components.MessageText

private val BubbleShape = RoundedCornerShape(20.dp)

/** A user message in a bubble at the end; an assistant reply as plain full-width text with its time below. */
@Composable
fun MessageItem(
    message: Message,
    onRetry: (String) -> Unit,
    imageLoader: MessageImageLoader,
    onOpenImage: (MessageImage) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (message.scheduled) {
        ScheduledCard(message, modifier)
        return
    }
    message.finishedList?.let { list ->
        FinishedListCard(list, message, modifier)
        return
    }
    if (message.author != Author.USER) {
        Column(modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
            MessageText(
                text = message.text,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = formatTime(message.sentAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        return
    }
    val content = MaterialTheme.colorScheme.onPrimary
    Row(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Spacer(Modifier.fillMaxWidth(BUBBLE_INSET_FRACTION))
        val failed = message.sendState == SendState.FAILED
        val retry = if (failed) Modifier.clickable { onRetry(message.id) } else Modifier
        Surface(
            shape = BubbleShape,
            color = MaterialTheme.colorScheme.primary,
            contentColor = content,
            modifier = Modifier.weight(1f, fill = false).clip(BubbleShape).then(retry),
        ) {
            Column(modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp)) {
                message.images.forEach { image ->
                    BubbleImage(
                        image = image,
                        loader = imageLoader,
                        onOpen = { if (failed) onRetry(message.id) else onOpenImage(image) },
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                if (message.text.isNotEmpty()) {
                    Text(text = message.text, style = MaterialTheme.typography.bodyLarge)
                }
                message.failure?.let {
                    Text(text = it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp))
                }
                val status = when (message.sendState) {
                    SendState.STORED -> formatTime(message.sentAt)
                    SendState.PENDING -> stringResource(R.string.message_sending)
                    SendState.FAILED -> stringResource(R.string.message_not_sent)
                }
                Text(
                    text = status,
                    style = MaterialTheme.typography.labelSmall,
                    color = content.copy(alpha = TIME_ALPHA),
                    modifier = Modifier.align(Alignment.End).padding(top = 4.dp),
                )
            }
        }
    }
}

/**
 * A delivery of a scheduled job: a short first line as the bold title beside an alarm icon and the time,
 * the rest below at the card's full width. A long first line stays in the body, so it gets the full width.
 */
@Composable
private fun ScheduledCard(message: Message, modifier: Modifier) {
    val firstLine = message.text.substringBefore('\n')
    var title: String? = null
    var body = message.text
    if (firstLine.length <= TITLE_MAX_CHARS) {
        title = firstLine
        body = message.text.substringAfter('\n', "").trim()
    }
    val content = MaterialTheme.colorScheme.onPrimaryContainer
    Surface(
        shape = CardShape,
        color = MaterialTheme.colorScheme.primaryContainer,
        contentColor = content,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Alarm,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimary,
                        modifier = Modifier.size(22.dp),
                    )
                }
                if (title != null) {
                    MessageText(
                        text = title,
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                        color = content,
                        modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                    )
                } else {
                    Spacer(Modifier.weight(1f))
                }
                Text(
                    text = formatTime(message.sentAt),
                    style = MaterialTheme.typography.labelMedium,
                    color = content.copy(alpha = TIME_ALPHA),
                )
            }
            if (body.isNotEmpty()) {
                MessageText(text = body, style = MaterialTheme.typography.bodyLarge, color = content)
            }
        }
    }
}

/** A finished list: an outlined card with its name, its count and when it finished. */
@Composable
private fun FinishedListCard(list: FinishedList, message: Message, modifier: Modifier) {
    Surface(
        shape = CardShape,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = modifier,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Icon(
                imageVector = Icons.Outlined.TaskAlt,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(28.dp),
            )
            Column(modifier = Modifier.padding(start = 16.dp)) {
                Text(
                    text = stringResource(R.string.list_finished_title, list.name, list.total),
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                )
                Text(
                    text = stringResource(R.string.list_finished_text, formatTime(message.sentAt)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private val CardShape = RoundedCornerShape(24.dp)

/** The longest first line a scheduled card shows as its title. */
private const val TITLE_MAX_CHARS = 60

/** Share of the width a bubble leaves free on its start side. */
private const val BUBBLE_INSET_FRACTION = 0.2f
private const val TIME_ALPHA = 0.7f

