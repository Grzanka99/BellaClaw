package one.scary.bellaclaw.ui.chat

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.CommandRow
import one.scary.bellaclaw.model.CommandState
import one.scary.bellaclaw.model.CommandTone
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.ui.components.MessageText
import one.scary.bellaclaw.ui.theme.BellaClawThemeTokens

/**
 * A command's run: folded, a chip with the command and its outcome below it; open, the card with one step line per
 * reply or notice, rows as one item each. A tap on the header folds or unfolds it with [onToggle]; a failed
 * send retries on [onRetry].
 */
@Composable
fun CommandCard(card: ChatRow.Command, onToggle: () -> Unit, onRetry: (String) -> Unit, modifier: Modifier = Modifier) {
    val open = !card.isFolded
    val rotation by animateFloatAsState(if (open) 180f else 0f, label = "chevron")
    val width = if (open) Modifier.fillMaxWidth() else Modifier
    Surface(
        shape = RoundedCornerShape(if (open) 18.dp else 14.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.then(width).animateContentSize(),
    ) {
        Column {
            Row(
                modifier = Modifier.clickable(onClick = onToggle).heightIn(min = 32.dp).padding(start = 10.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Terminal, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Column(modifier = Modifier.weight(1f, fill = false)) {
                    Text(
                        text = card.header,
                        style = MaterialTheme.typography.labelLarge.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    card.outcome?.let {
                        Text(text = it, style = MaterialTheme.typography.labelMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (card.state == CommandState.RUNNING) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Icon(
                        Icons.Outlined.ExpandMore,
                        contentDescription = stringResource(if (open) R.string.command_hide else R.string.command_show),
                        modifier = Modifier.size(18.dp).rotate(rotation),
                    )
                }
            }
            if (open) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    card.lines.forEach { line ->
                        if (line.rows.isEmpty()) {
                            StepLine(line)
                        } else {
                            ResultRows(line.rows)
                        }
                    }
                    if (card.sendState == SendState.PENDING && card.lines.isEmpty()) {
                        Text(text = stringResource(R.string.message_sending), style = MaterialTheme.typography.bodySmall)
                    }
                    if (card.sendState == SendState.FAILED) {
                        Column(modifier = Modifier.clickable { onRetry(checkNotNull(card.retryId)) }) {
                            card.failure?.let {
                                Text(text = it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                            }
                            Text(text = stringResource(R.string.message_not_sent), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}

/** A reply or notice as text, after its state's icon. */
@Composable
private fun StepLine(line: CommandLine) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(modifier = Modifier.padding(top = 2.dp)) {
            when (line.state) {
                CommandState.RUNNING -> CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                CommandState.DONE -> Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                CommandState.FAILED -> Icon(
                    Icons.Outlined.ErrorOutline,
                    contentDescription = stringResource(R.string.activity_failed),
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        MessageText(text = line.text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
    }
}

/** One item per row: its title, a status label coloured by its tone, and its detail, wrapping anywhere. */
@Composable
private fun ResultRows(rows: List<CommandRow>) {
    Column {
        rows.forEachIndexed { index, row ->
            if (index > 0) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            Row(
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(text = row.title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
                    row.detail?.let { Text(text = it, style = MaterialTheme.typography.bodySmall) }
                }
                row.status?.let { status ->
                    val extra = BellaClawThemeTokens.extraColors
                    val (background, content) = when (status.tone) {
                        CommandTone.NEUTRAL -> MaterialTheme.colorScheme.surfaceContainerHighest to MaterialTheme.colorScheme.onSurfaceVariant
                        CommandTone.GOOD -> extra.doneContainer to extra.onDoneContainer
                        CommandTone.WARNING -> extra.warningContainer to extra.onWarningContainer
                        CommandTone.BAD -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
                    }
                    Surface(shape = RoundedCornerShape(6.dp), color = background, contentColor = content) {
                        Text(
                            text = status.label,
                            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Medium),
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
            }
        }
    }
}
