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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.ui.components.formatTime
import one.scary.bellaclaw.ui.components.styledText

private val BubbleShape = RoundedCornerShape(20.dp)

@Composable
fun MessageItem(
    message: Message,
    assistantInBubble: Boolean,
    onRetry: (String) -> Unit,
    imageLoader: MessageImageLoader,
    onOpenImage: (MessageImage) -> Unit,
    modifier: Modifier = Modifier,
) {
    val fromUser = message.author == Author.USER
    if (!fromUser && !assistantInBubble) {
        Text(
            text = remember(message.text) { styledText(message.text) },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp),
        )
        return
    }
    val container = if (fromUser) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest
    val content = if (fromUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = if (fromUser) Arrangement.End else Arrangement.Start,
    ) {
        if (fromUser) {
            Spacer(Modifier.fillMaxWidth(BUBBLE_INSET_FRACTION))
        }
        val failed = message.sendState == SendState.FAILED
        val retry = if (failed) Modifier.clickable { onRetry(message.id) } else Modifier
        Surface(
            shape = BubbleShape,
            color = container,
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
                    val text = if (fromUser) {
                        AnnotatedString(message.text)
                    } else {
                        remember(message.text) { styledText(message.text) }
                    }
                    Text(text = text, style = MaterialTheme.typography.bodyLarge)
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
        if (!fromUser) {
            Spacer(Modifier.fillMaxWidth(BUBBLE_INSET_FRACTION))
        }
    }
}

/** Share of the width a bubble leaves free on its far side. */
private const val BUBBLE_INSET_FRACTION = 0.2f
private const val TIME_ALPHA = 0.7f

