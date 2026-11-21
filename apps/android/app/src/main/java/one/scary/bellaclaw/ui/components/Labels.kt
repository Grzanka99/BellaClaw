package one.scary.bellaclaw.ui.components

import androidx.annotation.StringRes
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelRole
import one.scary.bellaclaw.model.ServiceTier
import one.scary.bellaclaw.model.ThemeMode

@get:StringRes
val Effort.label: Int
    get() = when (this) {
        Effort.OFF -> R.string.effort_off
        Effort.MINIMAL -> R.string.effort_minimal
        Effort.LOW -> R.string.effort_low
        Effort.MEDIUM -> R.string.effort_medium
        Effort.HIGH -> R.string.effort_high
        Effort.XHIGH -> R.string.effort_xhigh
        Effort.MAX -> R.string.effort_max
    }

@get:StringRes
val ServiceTier.label: Int
    get() = when (this) {
        ServiceTier.DEFAULT -> R.string.service_tier_default
        ServiceTier.FLEX -> R.string.service_tier_flex
        ServiceTier.PRIORITY -> R.string.service_tier_priority
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
