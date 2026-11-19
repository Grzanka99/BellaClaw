package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.ui.components.formatTime

private val BubbleShape = RoundedCornerShape(20.dp)

@Composable
fun MessageItem(
    message: Message,
    assistantInBubble: Boolean,
    thumbnailLoader: ThumbnailLoader,
    modifier: Modifier = Modifier,
) {
    val fromUser = message.author == Author.USER
    if (!fromUser && !assistantInBubble) {
        Text(
            text = message.text,
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
        Surface(
            shape = BubbleShape,
            color = container,
            contentColor = content,
            modifier = Modifier.weight(1f, fill = false),
        ) {
            Column(modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp)) {
                message.imageUri?.let { uri ->
                    ImageThumbnail(
                        uri = uri,
                        loader = thumbnailLoader,
                        modifier = Modifier
                            .padding(bottom = 8.dp)
                            .size(180.dp)
                            .clip(RoundedCornerShape(12.dp)),
                    )
                }
                if (message.text.isNotEmpty()) {
                    Text(text = message.text, style = MaterialTheme.typography.bodyLarge)
                }
                Text(
                    text = formatTime(message.sentAt),
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

