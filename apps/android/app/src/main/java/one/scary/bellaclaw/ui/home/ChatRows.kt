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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.ui.components.BellaClawAvatar
import one.scary.bellaclaw.ui.components.Dot
import one.scary.bellaclaw.ui.components.formatListTime
import one.scary.bellaclaw.ui.components.imageVector

@Composable
fun BellaClawRow(summary: BellaClawSummary, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        ChatRowLayout(
            leading = { BellaClawAvatar(size = 56.dp) },
            title = stringResource(R.string.bellaclaw_name),
            titleStyle = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
            mutedColor = LocalContentColor.current.copy(alpha = 0.8f),
            isTimeCentered = true,
            summary = summary,
            modifier = Modifier.padding(vertical = 6.dp),
        )
    }
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
        mutedColor = MaterialTheme.colorScheme.onSurfaceVariant,
        isTimeCentered = false,
        summary = summary,
        modifier = modifier.clickable(onClick = onClick),
    )
}

@Composable
private fun ChatRowLayout(
    leading: @Composable () -> Unit,
    title: String,
    titleStyle: TextStyle,
    mutedColor: Color,
    isTimeCentered: Boolean,
    summary: ChatSummary,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, style = titleStyle, maxLines = 1, overflow = TextOverflow.Ellipsis)
            summary.preview?.let {
                Text(
                    text = it.ifEmpty { stringResource(R.string.image) },
                    style = MaterialTheme.typography.bodyMedium,
                    color = mutedColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        summary.lastActivity?.let {
            Spacer(Modifier.width(12.dp))
            // The pill's time sits in its vertical middle; a plain row's lines up with the title.
            val timeModifier = if (isTimeCentered) {
                Modifier.align(Alignment.CenterVertically)
            } else {
                Modifier.align(Alignment.Top).padding(top = 4.dp)
            }
            Column(
                modifier = timeModifier,
                horizontalAlignment = Alignment.End,
            ) {
                Text(
                    text = formatListTime(it),
                    style = MaterialTheme.typography.labelMedium,
                    color = mutedColor,
                )
                if (summary.isUnread) {
                    val unread = stringResource(R.string.unread)
                    Dot(
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 8.dp).semantics { contentDescription = unread },
                    )
                }
            }
        }
    }
}
