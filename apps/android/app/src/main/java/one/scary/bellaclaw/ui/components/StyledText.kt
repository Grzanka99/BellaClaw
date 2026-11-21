package one.scary.bellaclaw.ui.components

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle

private const val MONOSPACE = "`"

/** Each mark with its style; `**` before `*`, so bold is tried first. */
private val Marks = listOf(
    MONOSPACE to SpanStyle(fontFamily = FontFamily.Monospace),
    "**" to SpanStyle(fontWeight = FontWeight.Bold),
    "*" to SpanStyle(fontStyle = FontStyle.Italic),
    "~" to SpanStyle(textDecoration = TextDecoration.LineThrough),
)

/**
 * A message's text with `**bold**`, `*italic*`, `` `monospace` `` and `~strikethrough~` styled and
 * their marks removed. A mark styles only with a closing mark on its line and non-blank text between,
 * the opening mark followed and the closing mark preceded by a non-space; anything else stays as typed. Nothing inside monospace is styled further.
 */
fun styledText(text: String): AnnotatedString = buildAnnotatedString { appendStyled(text) }

private fun AnnotatedString.Builder.appendStyled(text: String) {
    var index = 0
    while (index < text.length) {
        val match = Marks.firstNotNullOfOrNull { (mark, style) ->
            val start = index + mark.length
            val end = text.indexOf(mark, start)
            val newline = text.indexOf('\n', start)
            val opens = text.startsWith(mark, index) && start < text.length && !text[start].isWhitespace()
            val closes = opens && end > start && newline !in start until end && !text[end - 1].isWhitespace()
            if (closes) Triple(mark, style, end) else null
        }
        if (match == null) {
            append(text[index])
            index++
            continue
        }
        val (mark, style, end) = match
        val inner = text.substring(index + mark.length, end)
        withStyle(style) { if (mark == MONOSPACE) append(inner) else appendStyled(inner) }
        index = end + mark.length
    }
}
