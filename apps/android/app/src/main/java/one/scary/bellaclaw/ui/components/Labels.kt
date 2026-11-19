package one.scary.bellaclaw.ui.components

import androidx.annotation.StringRes
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.ThemeMode

@get:StringRes
val Effort.label: Int
    get() = when (this) {
        Effort.LOW -> R.string.effort_low
        Effort.MEDIUM -> R.string.effort_medium
        Effort.HIGH -> R.string.effort_high
    }

@get:StringRes
val ModelRole.label: Int
    get() = when (this) {
        ModelRole.UTILITY -> R.string.role_utility
        ModelRole.MAIN -> R.string.role_main
        ModelRole.SPECIALIST -> R.string.role_specialist
        ModelRole.SPECIALIST_ACCURATE -> R.string.role_specialist_accurate
        ModelRole.SCHEDULED_TASK -> R.string.role_scheduled_task
    }

@get:StringRes
val ThemeMode.label: Int
    get() = when (this) {
        ThemeMode.SYSTEM -> R.string.theme_system
        ThemeMode.LIGHT -> R.string.theme_light
        ThemeMode.DARK -> R.string.theme_dark
    }
