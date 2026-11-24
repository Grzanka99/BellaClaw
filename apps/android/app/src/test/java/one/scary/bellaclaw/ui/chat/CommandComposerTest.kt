package one.scary.bellaclaw.ui.chat

import one.scary.bellaclaw.model.CommandEntry
import one.scary.bellaclaw.model.usageChoices
import org.junit.Assert.assertEquals
import org.junit.Test

class CommandComposerTest {
    // usages as in packages/shared/src/commands.ts
    private val catalog = listOf(
        CommandEntry("connector", "Connectors", "", "!connector list | !connector approve|reject CONNECTOR"),
        CommandEntry(
            "connector-auth",
            "Connectors",
            "",
            "!connector-auth connect|disconnect|status CONNECTOR | !connector-auth token CONNECTOR TOKEN",
        ),
        CommandEntry("mcp-prompts", "Connectors", "", "!mcp-prompts [CONNECTOR]"),
        CommandEntry("mcp-prompt", "Connectors", "", "!mcp-prompt CONNECTOR PROMPT [JSON_ARGUMENTS]"),
        CommandEntry("calendar_add-write", "Calendar", "", "!calendar_add-write CALENDAR_ID"),
        CommandEntry("calendar_add-read", "Calendar", "", "!calendar_add-read CALENDAR_ID"),
        CommandEntry("ai-auth", "AI", "", "!ai-auth login|status|logout PROVIDER"),
        CommandEntry("update", "App", "", "!update"),
        CommandEntry("dashboard", "App", "", "!dashboard"),
        CommandEntry("app", "App", "", "!app"),
    )

    private fun entry(name: String) = catalog.first { it.name == name }

    @Test
    fun `usage choices are the fixed words after the command word, merged across forms`() {
        val choices = catalog.associate { it.name to usageChoices(it) }
        assertEquals(
            mapOf(
                "connector" to listOf("list", "approve", "reject"),
                "connector-auth" to listOf("connect", "disconnect", "status", "token"),
                "mcp-prompts" to emptyList(),
                "mcp-prompt" to emptyList(),
                "calendar_add-write" to emptyList(),
                "calendar_add-read" to emptyList(),
                "ai-auth" to listOf("login", "status", "logout"),
                "update" to emptyList(),
                "dashboard" to emptyList(),
                "app" to emptyList<String>(),
            ),
            choices,
        )
    }

    @Test
    fun `palette lists the commands starting with the typed prefix, grouped in catalog order`() {
        assertEquals(
            CommandComposerState.Palette(
                listOf(
                    "Connectors" to listOf(entry("connector"), entry("connector-auth")),
                    "Calendar" to listOf(entry("calendar_add-write"), entry("calendar_add-read")),
                ),
                "c",
            ),
            commandComposerState("!C", catalog),
        )
        val all = commandComposerState("!", catalog) as CommandComposerState.Palette
        assertEquals(catalog, all.groups.flatMap { it.second })
    }

    @Test
    fun `a full command word is recognised, with choices only until an argument follows`() {
        val connector = entry("connector")
        assertEquals(
            CommandComposerState.Recognised(connector, listOf("list", "approve", "reject")),
            commandComposerState("!connector ", catalog),
        )
        assertEquals(CommandComposerState.Recognised(connector, emptyList()), commandComposerState("!connector li", catalog))
    }

    @Test
    fun `an unknown word, plain text or an empty catalog offers nothing`() {
        assertEquals(CommandComposerState.None, commandComposerState("!weather", catalog))
        assertEquals(CommandComposerState.None, commandComposerState("!conn x", catalog))
        assertEquals(CommandComposerState.None, commandComposerState("connector", catalog))
        assertEquals(CommandComposerState.None, commandComposerState("!connector", emptyList()))
    }
}
