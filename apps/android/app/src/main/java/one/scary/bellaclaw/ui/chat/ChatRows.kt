package one.scary.bellaclaw.ui.chat

import one.scary.bellaclaw.model.ActivityStep
import one.scary.bellaclaw.model.Message
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.roundToLong

/**
 * [messages] (oldest first) as list rows, newest first, with a [ChatRow.Day] above each day's messages in [zone]
 * and a [ChatRow.Activity] above each reply that took steps, keyed by [activityKeys] for its first step's start
 * when it has one there.
 */
fun chatRows(messages: List<Message>, zone: ZoneId, activityKeys: Map<Instant, String> = emptyMap()): List<ChatRow> = buildList {
    var day: LocalDate? = null
    messages.forEach { message ->
        val date = message.sentAt.atZone(zone).toLocalDate()
        if (date != day) {
            day = date
            add(ChatRow.Day(date, message.id))
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
