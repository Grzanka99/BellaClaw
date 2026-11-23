package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import one.scary.bellaclaw.model.CommandEntry
import one.scary.bellaclaw.model.usageChoices

/** What the composer offers for a draft that may be a "!" command. */
sealed interface CommandComposerState {
    data object None : CommandComposerState

    /** Commands whose name starts with [typed], grouped in catalog order. */
    data class Palette(val groups: List<Pair<String, List<CommandEntry>>>, val typed: String) : CommandComposerState

    /** The first word is [entry]; [choices] for the next word, empty once anything follows the command word. */
    data class Recognised(val entry: CommandEntry, val choices: List<String>) : CommandComposerState
}

/** The command state of [draft]: the first word, without "!" and lower-cased, against [commands]. */
fun commandComposerState(draft: String, commands: List<CommandEntry>): CommandComposerState {
    if (commands.isEmpty() || !draft.startsWith("!")) {
        return CommandComposerState.None
    }
    val parts = draft.split(Regex("\\s"), limit = 2)
    val name = parts.first().removePrefix("!").lowercase()
    val entry = commands.firstOrNull { it.name == name }
    if (entry != null) {
        val rest = parts.getOrNull(1).orEmpty()
        if (rest.isBlank()) {
            return CommandComposerState.Recognised(entry, usageChoices(entry))
        }
        return CommandComposerState.Recognised(entry, emptyList())
    }
    if (parts.size > 1) {
        return CommandComposerState.None
    }
    val matches = commands.filter { it.name.startsWith(name) }
    if (matches.isEmpty()) {
        return CommandComposerState.None
    }
    return CommandComposerState.Palette(matches.groupBy { it.group }.toList(), name)
}

private val MonoStyle = SpanStyle(fontFamily = FontFamily.Monospace)

/** The commands matching what was typed, inside the composer box above the field; a tap picks one. */
@Composable
fun CommandPalette(palette: CommandComposerState.Palette, onPick: (CommandEntry) -> Unit) {
    Column(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()).padding(top = 8.dp)) {
        palette.groups.forEach { (group, entries) ->
            Text(
                text = group,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 20.dp, top = 8.dp, end = 20.dp, bottom = 4.dp),
            )
            entries.forEach { entry ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onPick(entry) }
                        .padding(horizontal = 20.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = buildAnnotatedString {
                            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                                append("!" + palette.typed)
                            }
                            append(entry.name.removePrefix(palette.typed))
                        },
                        style = MaterialTheme.typography.bodyMedium.merge(MonoStyle),
                        maxLines = 1,
                        modifier = Modifier.alignByBaseline(),
                    )
                    Text(
                        text = entry.description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).alignByBaseline(),
                    )
                }
            }
        }
        HorizontalDivider(Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** Above a recognised command's box: its usage line and chips for the next word. */
@Composable
fun CommandHints(recognised: CommandComposerState.Recognised, onChoice: (String) -> Unit, hazeState: HazeState) {
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.padding(horizontal = 8.dp)) {
        Surface(
            shape = shape,
            color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = GLASS_ALPHA),
            modifier = Modifier.frosted(hazeState, shape),
        ) {
            Text(
                text = recognised.entry.usage,
                style = MaterialTheme.typography.bodySmall.merge(MonoStyle),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        if (recognised.choices.isNotEmpty()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            ) {
                recognised.choices.forEach { choice ->
                    SuggestionChip(
                        onClick = { onChoice(choice) },
                        label = { Text(choice) },
                        colors = SuggestionChipDefaults.suggestionChipColors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        ),
                    )
                }
            }
        }
    }
}

/** Draws the command word, up to the first whitespace, in [color]. */
class CommandWordTransformation(private val color: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val end = text.indexOfFirst { it.isWhitespace() }.takeIf { it >= 0 } ?: text.length
        val styled = buildAnnotatedString {
            append(text)
            addStyle(SpanStyle(color = color), 0, end)
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }
}
