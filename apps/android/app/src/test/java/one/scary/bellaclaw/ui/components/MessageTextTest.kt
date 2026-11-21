package one.scary.bellaclaw.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class MessageTextTest {
    @Test
    fun fencesSplitProseFromCodeWithTheLanguageDropped() {
        val text = "Run this:\n```bash\nbun install\nbun test\n```\nThen restart."
        assertEquals(
            listOf(
                MessageBlock.Prose("Run this:"),
                MessageBlock.Code("bun install\nbun test"),
                MessageBlock.Prose("Then restart."),
            ),
            messageBlocks(text),
        )
    }

    @Test
    fun aPipeTableBecomesRowsWithShortRowsPadded() {
        val text = "Plan:\n| Day | Event |\n|---|:---:|\n| Mon | Gym |\n| Tue |\nDone."
        assertEquals(
            listOf(
                MessageBlock.Prose("Plan:"),
                MessageBlock.Table(listOf(listOf("Day", "Event"), listOf("Mon", "Gym"), listOf("Tue", ""))),
                MessageBlock.Prose("Done."),
            ),
            messageBlocks(text),
        )
    }

    @Test
    fun textWithoutFencesIsOneProseBlock() {
        assertEquals(listOf(MessageBlock.Prose("Use `bun test`.")), messageBlocks("Use `bun test`."))
    }
}
