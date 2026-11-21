package one.scary.bellaclaw.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.unit.sp

private val Material = Typography()

/** Material 3 type scale with the platform font (Roboto), as in the designs, with body text at normal letter spacing. */
internal val BellaClawTypography = Material.copy(
    bodyLarge = Material.bodyLarge.copy(letterSpacing = 0.sp),
    bodyMedium = Material.bodyMedium.copy(letterSpacing = 0.sp),
    bodySmall = Material.bodySmall.copy(letterSpacing = 0.sp),
)
