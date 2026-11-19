package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private const val TYPING_KEY = "typing"

/**
 * The conversation, newest at the bottom. [rows] come newest first. [assistantInBubbles] draws
 * assistant replies in bubbles (BellaClaw); otherwise they are plain full-width text (plain chats).
 * A new bottom item scrolls into view when the reader was at the bottom; otherwise the list stays put.
 */
@Composable
fun MessageList(
    rows: List<ChatRow>,
    isTyping: Boolean,
    assistantInBubbles: Boolean,
    thumbnailLoader: ThumbnailLoader,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0 } }
    val bottomKey = if (isTyping) TYPING_KEY else rows.firstOrNull()?.key
    // Read while composing the new bottom item, so it reflects the layout from before that item.
    val follow = remember(bottomKey) { atBottom }
    LaunchedEffect(bottomKey) {
        if (follow) {
            listState.scrollToItem(0)
        }
    }
    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        reverseLayout = true,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (isTyping) {
            item(key = TYPING_KEY) {
                Box(modifier = Modifier.fillMaxWidth()) {
                    TypingIndicator()
                }
            }
        }
        items(rows, key = { it.key }) { row ->
            when (row) {
                is ChatRow.Day -> DayChip(row.date)
                is ChatRow.Item -> MessageItem(row.message, assistantInBubbles, thumbnailLoader)
            }
        }
    }
}

@Composable
private fun DayChip(date: LocalDate) {
    val today = LocalDate.now()
    val label = when (date) {
        today -> stringResource(R.string.day_today)
        today.minusDays(1) -> stringResource(R.string.day_yesterday)
        else -> date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    }
    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }
    }
}
