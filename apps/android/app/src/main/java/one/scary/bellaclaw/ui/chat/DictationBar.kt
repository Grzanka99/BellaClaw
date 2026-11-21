package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import java.util.Locale

/**
 * The composer while dictating: the heard text with its language above, and a bar with the loudness and
 * the finish button. Tapping the text finishes too, for fixing it at once.
 */
@Composable
fun DictationBar(dictation: Dictation, onFinish: () -> Unit, onEditText: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth().padding(8.dp)) {
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onEditText),
        ) {
            Column(modifier = Modifier.padding(start = 16.dp, end = 12.dp, bottom = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.dictation_listening),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.weight(1f),
                    )
                    LanguageChip(
                        language = dictation.language,
                        languages = dictation.languages,
                        onPick = dictation::switchLanguage,
                    )
                }
                // Newest words stay in sight; the card stops growing so the bar below stays on screen.
                Text(
                    text = dictation.text,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier
                        .heightIn(max = 160.dp)
                        .verticalScroll(rememberScrollState(), reverseScrolling = true),
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Surface(
                shape = RoundedCornerShape(28.dp),
                color = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.weight(1f).height(56.dp),
            ) {
                Waveform(levels = dictation.levels, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
            }
            Spacer(Modifier.width(8.dp))
            FilledIconButton(onClick = onFinish, modifier = Modifier.size(56.dp)) {
                Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.action_finish_dictation))
            }
        }
    }
}

@Composable
private fun LanguageChip(language: Locale, languages: List<Locale>, onPick: (Locale) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        AssistChip(
            onClick = { expanded = true },
            label = { Text(language.language.uppercase(Locale.ROOT), fontWeight = FontWeight.SemiBold) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, contentDescription = null, modifier = Modifier.size(18.dp)) },
            shape = CircleShape,
            colors = AssistChipDefaults.assistChipColors(
                containerColor = MaterialTheme.colorScheme.secondaryContainer,
                labelColor = MaterialTheme.colorScheme.onSecondaryContainer,
                trailingIconContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
            ),
            border = null,
            modifier = Modifier.height(28.dp),
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            languages.forEach { locale ->
                DropdownMenuItem(
                    text = { Text(locale.getDisplayName(locale).replaceFirstChar { it.titlecase(locale) }) },
                    leadingIcon = {
                        if (locale == language) {
                            Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.dictation_language_current))
                        } else {
                            Spacer(Modifier.size(24.dp))
                        }
                    },
                    onClick = {
                        expanded = false
                        onPick(locale)
                    },
                )
            }
        }
    }
}

/** Bars for [levels], newest on the right; slots not heard yet draw as silence. */
@Composable
private fun Waveform(levels: List<Float>, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.primary
    Canvas(modifier = modifier.fillMaxWidth().height(32.dp)) {
        val slot = size.width / Dictation.LEVEL_COUNT
        val barWidth = slot * 0.5f
        val offset = Dictation.LEVEL_COUNT - levels.size
        for (index in 0 until Dictation.LEVEL_COUNT) {
            val level = levels.getOrNull(index - offset) ?: 0f
            val barHeight = maxOf(barWidth, size.height * level)
            drawRoundRect(
                color = color,
                topLeft = Offset(index * slot + (slot - barWidth) / 2, (size.height - barHeight) / 2),
                size = Size(barWidth, barHeight),
                cornerRadius = CornerRadius(barWidth / 2),
            )
        }
    }
}
