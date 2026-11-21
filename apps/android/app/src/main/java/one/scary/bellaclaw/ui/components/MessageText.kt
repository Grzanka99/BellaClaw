package one.scary.bellaclaw.ui.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

private const val FENCE = "```"
private const val CODE_BACKGROUND_ALPHA = 0.08f
private const val TABLE_DIVIDER_ALPHA = 0.2f

/** A `|---|:---:|` line under a table's header. */
private val TableSeparator = Regex("""^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$""")

/** A part of a message: styled text, a fenced code block shown as typed, or a table. */
sealed interface MessageBlock {
    data class Prose(val text: String) : MessageBlock

    data class Code(val code: String) : MessageBlock

    /** [rows] start with the header; every row has as many cells as the header. */
    data class Table(val rows: List<List<String>>) : MessageBlock
}

/**
 * Splits [text] into blocks. A line starting with ``` opens a code block (the rest of that line, its
 * language, is dropped) and the next such line closes it; an unclosed block runs to the end. Outside code,
 * a `|`-line followed by a separator line starts a table, which runs while lines start with `|`. Blank
 * prose between blocks is dropped.
 */
fun messageBlocks(text: String): List<MessageBlock> {
    val blocks = mutableListOf<MessageBlock>()
    val prose = mutableListOf<String>()
    fun flushProse() {
        val joined = prose.joinToString("\n")
        if (joined.isNotBlank()) {
            blocks += MessageBlock.Prose(joined.trim('\n'))
        }
        prose.clear()
    }
    val lines = text.lines()
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        if (line.trimStart().startsWith(FENCE)) {
            flushProse()
            val end = (index + 1 until lines.size).firstOrNull { lines[it].trimStart().startsWith(FENCE) } ?: lines.size
            blocks += MessageBlock.Code(lines.subList(index + 1, end).joinToString("\n"))
            index = end + 1
        } else if (line.trimStart().startsWith("|") && index + 1 < lines.size && TableSeparator.matches(lines[index + 1])) {
            flushProse()
            val header = tableCells(line)
            var end = index + 2
            while (end < lines.size && lines[end].trimStart().startsWith("|")) {
                end++
            }
            val body = lines.subList(index + 2, end).map { row ->
                val cells = tableCells(row)
                List(header.size) { cells.getOrElse(it) { "" } }
            }
            blocks += MessageBlock.Table(listOf(header) + body)
            index = end
        } else {
            prose += line
            index++
        }
    }
    flushProse()
    return blocks
}

/** The trimmed cells of a `| a | b |` line. */
private fun tableCells(line: String): List<String> = line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

/** An assistant message's text: styled prose, with code blocks in a scrollable monospace box. */
@Composable
fun MessageText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val codeBackground = color.copy(alpha = CODE_BACKGROUND_ALPHA)
    val blocks = remember(text) { messageBlocks(text) }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block ->
            when (block) {
                is MessageBlock.Prose -> Text(
                    text = remember(block.text, codeBackground) { styledText(block.text, codeBackground) },
                    style = style,
                    color = color,
                )
                is MessageBlock.Code -> Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = codeBackground,
                    contentColor = color,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = block.code,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        softWrap = false,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
                is MessageBlock.Table -> MessageTable(block.rows, color, codeBackground)
            }
        }
    }
}

/**
 * A table as columns side by side, scrolling sideways when wide: a bold header, a divider under each row.
 * Cells do not wrap, so every row of a column has one line's height and rows line up across columns.
 */
@Composable
private fun MessageTable(rows: List<List<String>>, color: Color, codeBackground: Color) {
    val divider = color.copy(alpha = TABLE_DIVIDER_ALPHA)
    val cellStyle = MaterialTheme.typography.bodyMedium
    Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        rows.first().indices.forEach { column ->
            Column(modifier = Modifier.width(IntrinsicSize.Max)) {
                rows.forEachIndexed { row, cells ->
                    Text(
                        text = remember(cells[column], codeBackground) { styledText(cells[column], codeBackground) },
                        style = cellStyle,
                        color = color,
                        fontWeight = if (row == 0) FontWeight.Bold else null,
                        softWrap = false,
                        modifier = Modifier
                            .fillMaxWidth()
                            .drawBehind {
                                drawLine(divider, Offset(0f, size.height), Offset(size.width, size.height), strokeWidth = 1.dp.toPx())
                            }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}
