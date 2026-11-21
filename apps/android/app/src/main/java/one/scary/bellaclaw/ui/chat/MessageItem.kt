package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Author
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

/** Share of the width a bubble leaves free on its start side. */
private const val BUBBLE_INSET_FRACTION = 0.2f
private const val TIME_ALPHA = 0.7f

