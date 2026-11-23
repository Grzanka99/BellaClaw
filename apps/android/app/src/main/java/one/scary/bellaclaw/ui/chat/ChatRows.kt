package one.scary.bellaclaw.ui.chat

import one.scary.bellaclaw.model.ActivityStep
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.CommandRun
import one.scary.bellaclaw.model.CommandState
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.SendState
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.roundToLong

/**
 * [messages] (oldest first) as list rows, newest first, with a [ChatRow.Day] above each day's messages in [zone]
 * and a [ChatRow.Activity] above each reply that took steps, keyed by [activityKeys] for its first step's start
 * when it has one there. The rows of a command's run are one [ChatRow.Command] where its first row is.
 */
fun chatRows(messages: List<Message>, zone: ZoneId, activityKeys: Map<Instant, String> = emptyMap()): List<ChatRow> {
    // A run's card is keyed by its request's client message id when it has one, else by its run id.
    val requestIds = HashMap<String, String>()
    messages.forEach { message ->
        val command = message.command
        val clientMessageId = message.clientMessageId
        if (command != null && clientMessageId != null) {
            requestIds[command.runId] = clientMessageId
        }
    }
    fun cardKeyOf(message: Message, command: CommandRun) = message.clientMessageId ?: requestIds[command.runId] ?: command.runId
    val runs = HashMap<String, MutableList<Pair<Message, CommandRun>>>()
    messages.forEach { message ->
        val command = message.command ?: return@forEach
        runs.getOrPut(cardKeyOf(message, command)) { mutableListOf() }.add(message to command)
    }
    return buildList {
        var day: LocalDate? = null
        val placed = HashSet<String>()
        messages.forEach { message ->
            val date = message.sentAt.atZone(zone).toLocalDate()
            if (date != day) {
                day = date
                add(ChatRow.Day(date, message.id))
            }
            val command = message.command
            if (command != null) {
                val cardKey = cardKeyOf(message, command)
                if (placed.add(cardKey)) {
                    add(commandCard(cardKey, runs.getValue(cardKey)))
                }
                return@forEach
            }
            if (message.steps.isNotEmpty()) {
                val start = message.steps.minOf { it.startedAt }
                val end = message.steps.maxOf { it.startedAt.toEpochMilli() + (it.durationMs ?: 0) }
                val seconds = ((end - start.toEpochMilli()) / 1000.0).roundToLong().coerceAtLeast(1)
                val key = activityKeys[start] ?: "activity-${message.id}"
                add(ChatRow.Activity(key, activityRows(message.steps, isThinking = false), seconds))
            }
            add(ChatRow.Item(message))
        }
    }.asReversed()
}

/**
 * The card of one run's [rows], oldest first. Its state and outcome are the newest stored or streamed row's,
 * the pending send's only while it has none. A failed send's card shows open, so its retry shows; any
 * other finished one starts folded.
 */
private fun commandCard(cardKey: String, rows: List<Pair<Message, CommandRun>>): ChatRow.Command {
    val request = rows.firstOrNull { (message, _) -> message.author == Author.USER }?.first
    val newest = (rows.lastOrNull { (message, command) -> command.runId != "pending-${message.clientMessageId}" } ?: rows.last()).second
    val sendState = request?.sendState ?: SendState.STORED
    val failed = sendState == SendState.FAILED
    val state = if (failed) CommandState.FAILED else newest.state
    val lines = rows.filter { (message, _) -> message.author == Author.ASSISTANT }.map { (message, command) ->
        CommandLine(message.text, command.state, command.rows)
    }
    return ChatRow.Command(
        key = "command-$cardKey",
        header = request?.text ?: "!${newest.name}",
        state = state,
        outcome = newest.outcome,
        lines = lines,
        isFolded = state != CommandState.RUNNING && !failed,
        sendState = sendState,
        failure = request?.failure.takeIf { failed },
        retryId = request?.id.takeIf { failed },
    )
}

/**
 * [steps] by start, with an [ActivityRow.Thought] before each step that began a second or more after
 * every earlier one had ended, and an [ActivityRow.Thinking] last when [isThinking] and no step runs.
 */
fun activityRows(steps: List<ActivityStep>, isThinking: Boolean): List<ActivityRow> = buildList {
    // When the steps so far had all ended, unless one still runs.
    var endedAt: Instant? = null
    var isRunning = false
    steps.sortedBy { it.startedAt }.forEach { step ->
        val previousEnd = endedAt
        if (!isRunning && previousEnd != null) {
            val gap = Duration.between(previousEnd, step.startedAt).toMillis()
            if (gap >= 1000) {
                add(ActivityRow.Thought((gap / 1000.0).roundToLong()))
            }
        }
        add(ActivityRow.Step(step))
        val end = step.durationMs?.let { step.startedAt.plusMillis(it) }
        if (end == null) {
            isRunning = true
        } else if (previousEnd == null || end > previousEnd) {
            endedAt = end
        }
    }
    if (isThinking && steps.isNotEmpty() && !isRunning) {
        add(ActivityRow.Thinking)
    }
}
