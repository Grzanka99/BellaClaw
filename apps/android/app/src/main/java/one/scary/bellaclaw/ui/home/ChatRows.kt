package one.scary.bellaclaw.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.ui.components.BellaClawAvatar
import one.scary.bellaclaw.ui.components.OnlineDot
import one.scary.bellaclaw.ui.components.formatListTime
import one.scary.bellaclaw.ui.components.imageVector

@Composable
fun BellaClawRow(summary: BellaClawSummary, onClick: () -> Unit, modifier: Modifier = Modifier) {
    ChatRowLayout(
        leading = { BellaClawAvatar(size = 56.dp) },
        title = stringResource(R.string.bellaclaw_name),
        titleStyle = MaterialTheme.typography.titleLarge,
        summary = summary,
        onClick = onClick,
        modifier = modifier.padding(vertical = 4.dp),
    )
}

@Composable
fun PlainChatRow(summary: PlainChatSummary, onClick: () -> Unit, modifier: Modifier = Modifier) {
    ChatRowLayout(
        leading = {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = summary.icon.imageVector,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface,
                )
            }
        },
        title = summary.title ?: stringResource(R.string.new_chat_title),
        titleStyle = MaterialTheme.typography.titleMedium,
        summary = summary,
        onClick = onClick,
        modifier = modifier,
    )
}

@Composable
private fun ChatRowLayout(
    leading: @Composable () -> Unit,
    title: String,
    titleStyle: TextStyle,
    summary: ChatSummary,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, style = titleStyle, maxLines = 1, overflow = TextOverflow.Ellipsis)
            summary.preview?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        summary.lastActivity?.let {
            Spacer(Modifier.width(12.dp))
            Column(
                modifier = Modifier.align(Alignment.Top).padding(top = 4.dp),
                horizontalAlignment = Alignment.End,
            ) {
                Text(
                    text = formatListTime(it),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (summary.isUnread) {
                    val unread = stringResource(R.string.unread)
                    OnlineDot(
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 8.dp).semantics { contentDescription = unread },
                    )
                }
            }
        }
    }
}
