package one.scary.bellaclaw.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BakeryDining
import androidx.compose.material.icons.outlined.Calculate
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.FilterAlt
import androidx.compose.material.icons.outlined.Flight
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.Pets
import androidx.compose.material.icons.outlined.RocketLaunch
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Translate
import androidx.compose.ui.graphics.vector.ImageVector
import one.scary.bellaclaw.model.ChatIcon

val ChatIcon.imageVector: ImageVector
    get() = when (this) {
        ChatIcon.CODE -> Icons.Outlined.Code
        ChatIcon.TRANSLATE -> Icons.Outlined.Translate
        ChatIcon.BAKERY -> Icons.Outlined.BakeryDining
        ChatIcon.FILTER -> Icons.Outlined.FilterAlt
        ChatIcon.ROCKET -> Icons.Outlined.RocketLaunch
        ChatIcon.LIGHTBULB -> Icons.Outlined.Lightbulb
        ChatIcon.TERMINAL -> Icons.Outlined.Terminal
        ChatIcon.FLIGHT -> Icons.Outlined.Flight
        ChatIcon.MUSIC -> Icons.Outlined.MusicNote
        ChatIcon.SCIENCE -> Icons.Outlined.Science
        ChatIcon.PETS -> Icons.Outlined.Pets
        ChatIcon.CALCULATE -> Icons.Outlined.Calculate
    }
