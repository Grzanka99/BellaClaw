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
import one.scary.bellaclaw.model.MessageImage
import one.scary.bellaclaw.model.SendState
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * The conversation, newest at the bottom. [rows] come newest first. User messages are bubbles,
 * assistant replies plain full-width text.
 * A reply's activity card shows below the newest row while the reply is in progress and stays the same
 * item above the reply once it lands; rows fade in and out. A card opened or closed by a tap keeps its
 * header in place and moves the rows below it instead.
 * A new bottom item scrolls into view when the reader was at the bottom or it is their own send;
 * otherwise the list stays put.
 * Reaching the oldest row asks for older ones with [onLoadOlder]; a failed send retries on [onRetry];
 * a tapped image opens with [onOpenImage].
 * [insets] keep the first and last rows clear of the bars the list scrolls under.
 */
@Composable
fun MessageList(
    rows: List<ChatRow>,
    onRetry: (String) -> Unit,
    onLoadOlder: () -> Unit,
    imageLoader: MessageImageLoader,
    onOpenImage: (MessageImage) -> Unit,
    insets: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    // The oldest row is the last item of the reversed list.
    val atTop by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()
            last != null && last.index == listState.layoutInfo.totalItemsCount - 1
        }
    }
    LaunchedEffect(atTop, rows.lastOrNull()?.key) {
        if (atTop) {
            onLoadOlder()
        }
    }
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0 } }
    val bottom = rows.firstOrNull()
    val bottomKey = bottom?.key
    // Read while composing the new bottom item, so it reflects the layout from before that item.
    // A card opened by a tap leaves the list off the bottom, so the reader's own send follows regardless.
    val follow = remember(bottomKey) { atBottom || (bottom is ChatRow.Item && bottom.message.sendState == SendState.PENDING) }
    LaunchedEffect(bottomKey) {
        if (follow) {
            listState.scrollToItem(0)
        }
    }
    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        reverseLayout = true,
        contentPadding = PaddingValues(
            start = 16.dp,
            end = 16.dp,
            top = 12.dp + insets.calculateTopPadding(),
            bottom = 12.dp + insets.calculateBottomPadding(),
        ),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(rows, key = { it.key }) { row ->
            // No placement animation: a resizing card would leave its neighbours sliding behind it.
            val animated = Modifier.animateItem(placementSpec = null)
            when (row) {
                is ChatRow.Day -> DayChip(row.date, animated)
                is ChatRow.Item -> MessageItem(row.message, onRetry, imageLoader, onOpenImage, animated)
                is ChatRow.Activity -> ActivityCard(row.rows, row.seconds, row.isLive, { listState.dispatchRawDelta(it) }, animated)
            }
        }
    }
}

@Composable
private fun DayChip(date: LocalDate, modifier: Modifier = Modifier) {
    val today = LocalDate.now()
    val label = when (date) {
        today -> stringResource(R.string.day_today)
        today.minusDays(1) -> stringResource(R.string.day_yesterday)
        else -> date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    }
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
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
