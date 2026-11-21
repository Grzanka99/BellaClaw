package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.TodoList
import one.scary.bellaclaw.ui.components.formatEndTime
import one.scary.bellaclaw.ui.theme.BellaClawThemeTokens

private val PillShape = RoundedCornerShape(24.dp)

/**
 * The account's lists under BellaClaw's bar: the first of [lists] with its progress ring, its end and its count,
 * and "+N" for the others. Green once every item is ticked; then a swipe either way dismisses it. A tap opens it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListPill(lists: List<TodoList>, onOpen: (String) -> Unit, onDismiss: (TodoList) -> Unit, modifier: Modifier = Modifier) {
    val list = lists.firstOrNull() ?: return
    key(list.id, list.isFinished) {
        val state = rememberSwipeToDismissBoxState()
        SwipeToDismissBox(
            state = state,
            backgroundContent = {},
            modifier = modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            gesturesEnabled = list.isFinished,
            onDismiss = { onDismiss(list) },
        ) {
            PillContent(list, others = lists.size - 1, onOpen = { onOpen(list.id) })
        }
    }
}

@Composable
private fun PillContent(list: TodoList, others: Int, onOpen: () -> Unit) {
    val extra = BellaClawThemeTokens.extraColors
    val colors = MaterialTheme.colorScheme
    val finished = list.isFinished
    val content = if (finished) extra.onDoneContainer else colors.onPrimaryContainer
    Surface(
        onClick = onOpen,
        shape = PillShape,
        color = if (finished) extra.doneContainer else colors.primaryContainer,
        contentColor = content,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 8.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        ) {
            ProgressMark(list)
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = list.name,
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                pillSubtitle(list)?.let { subtitle ->
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = content.copy(alpha = SUBTITLE_ALPHA),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(
                text = stringResource(R.string.list_count, list.doneCount, list.items.size),
                style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                modifier = Modifier.padding(horizontal = 8.dp),
            )
            if (others > 0) {
                Text(
                    text = stringResource(R.string.list_more, others),
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.onPrimary,
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(colors.primary)
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
            Icon(
                imageVector = Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = stringResource(R.string.list_open),
            )
        }
    }
}

/** The ring of ticked items around the list mark; a filled green check once finished. */
@Composable
private fun ProgressMark(list: TodoList) {
    val colors = MaterialTheme.colorScheme
    if (list.isFinished) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.size(RING_SIZE).clip(CircleShape).background(BellaClawThemeTokens.extraColors.online),
        ) {
            Icon(Icons.Outlined.Check, contentDescription = null, tint = colors.surface, modifier = Modifier.size(20.dp))
        }
        return
    }
    Box(contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            progress = { if (list.items.isEmpty()) 0f else list.doneCount.toFloat() / list.items.size },
            modifier = Modifier.size(RING_SIZE),
            color = colors.primary,
            trackColor = colors.primary.copy(alpha = TRACK_ALPHA),
            strokeWidth = 4.dp,
            gapSize = 0.dp,
        )
        Icon(Icons.Outlined.Checklist, contentDescription = null, tint = colors.primary, modifier = Modifier.size(18.dp))
    }
}

/** "Until today 20:00"; once finished, "Done", with when it disappears. Null for a list that never ends and is open. */
@Composable
private fun pillSubtitle(list: TodoList): String? {
    val disappearsAt = list.disappearsAt
    if (list.isFinished) {
        if (disappearsAt == null) {
            return stringResource(R.string.list_done)
        }
        return stringResource(R.string.list_done_disappears, formatEndTime(disappearsAt))
    }
    return list.endsAt?.let { stringResource(R.string.list_until, formatEndTime(it)) }
}

private val RING_SIZE = 40.dp
private const val SUBTITLE_ALPHA = 0.8f
private const val TRACK_ALPHA = 0.18f
