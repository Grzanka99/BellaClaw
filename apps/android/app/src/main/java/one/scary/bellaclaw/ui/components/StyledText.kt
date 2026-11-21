package one.scary.bellaclaw.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import java.net.URI

private const val MONOSPACE = "`"

/** Each mark with its style; `**` before `*`, so bold is tried first. */
private val Marks = listOf(
    MONOSPACE to SpanStyle(fontFamily = FontFamily.Monospace),
    "**" to SpanStyle(fontWeight = FontWeight.Bold),
    "*" to SpanStyle(fontStyle = FontStyle.Italic),
    "~" to SpanStyle(textDecoration = TextDecoration.LineThrough),
)

private val LinkStyles = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline))

/** `[label](https://…)` on one line: an http(s) address with no spaces and a non-blank label. */
private val MarkdownLink = Regex("""\[([^\[\]\n]*\S[^\[\]\n]*)]\((https?://[^\s()]+)\)""")

/**
 * A message's text with `**bold**`, `*italic*`, `` `monospace` `` and `~strikethrough~` styled and
 * their marks removed. A mark styles only with a closing mark on its line and non-blank text between,
 * the opening mark followed and the closing mark preceded by a non-space; anything else stays as typed. Nothing inside monospace is styled further.
 * A `[label](https://…)` link shows its label, underlined, and opens the address when tapped; the site
 * follows in brackets when the label does not name it.
 * Monospace text gets [codeBackground].
 */
fun styledText(text: String, codeBackground: Color = Color.Unspecified): AnnotatedString =
    buildAnnotatedString { appendStyled(text, codeBackground) }

private fun AnnotatedString.Builder.appendStyled(text: String, codeBackground: Color) {
    var index = 0
    while (index < text.length) {
        val link = MarkdownLink.matchAt(text, index)
        if (link != null) {
            val (label, url) = link.destructured
            withLink(LinkAnnotation.Url(url, LinkStyles)) { appendStyled(label, codeBackground) }
            // a label that does not name the link's site gets the site after it, so a tap never surprises
            val host = URI(url).host?.removePrefix("www.")
            if (host != null && !label.contains(host, ignoreCase = true)) {
                append(" ($host)")
            }
            index = link.range.last + 1
            continue
        }
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
        if (mark == MONOSPACE) {
            withStyle(style.merge(SpanStyle(background = codeBackground))) { append(inner) }
        } else {
            withStyle(style) { appendStyled(inner, codeBackground) }
        }
        index = end + mark.length
    }
}
