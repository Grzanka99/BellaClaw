package one.scary.bellaclaw.ui.components

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.junit.Assert.assertEquals
import org.junit.Test

class StyledTextTest {
    private fun spans(text: AnnotatedString) = text.spanStyles.map { Triple(it.item, it.start, it.end) }

    @Test
    fun eachStyleAppliesToItsTextWithTheMarksRemoved() {
        val cases = listOf(
            "**20:46**" to SpanStyle(fontWeight = FontWeight.Bold),
            "*20:46*" to SpanStyle(fontStyle = FontStyle.Italic),
            "`20:46`" to SpanStyle(fontFamily = FontFamily.Monospace),
            "~20:46~" to SpanStyle(textDecoration = TextDecoration.LineThrough),
        )
        cases.forEach { (marked, style) ->
            val styled = styledText("At $marked.")
            assertEquals("At 20:46.", styled.text)
            assertEquals(listOf(Triple(style, 3, 8)), spans(styled))
        }
    }

    @Test
    fun aMarkdownLinkShowsItsLabelAndOpensItsAddress() {
        val styled = styledText("See [bun.com/blog](https://bun.com/blog/bun-v1.4), z 20.")
        assertEquals("See bun.com/blog, z 20.", styled.text)
        val links = styled.getLinkAnnotations(0, styled.length).map { Triple((it.item as LinkAnnotation.Url).url, it.start, it.end) }
        assertEquals(listOf(Triple("https://bun.com/blog/bun-v1.4", 4, 16)), links)
    }

    @Test
    fun anUnmatchedMarkStaysAsTyped() {
        listOf("2 * 3 = 6", "**open\nclosed**", "a ** b", "~ ~", "2 * 3 * 4", "~/Documents and ~/Downloads").forEach {
            val styled = styledText(it)
            assertEquals(it, styled.text)
            assertEquals(emptyList<Any>(), styled.spanStyles)
        }
    }

    @Test
    fun textInsideMonospaceIsNotStyledFurther() {
        val styled = styledText("`a **b** c`")

        assertEquals("a **b** c", styled.text)
        assertEquals(listOf(Triple(SpanStyle(fontFamily = FontFamily.Monospace), 0, 9)), spans(styled))
    }
}
