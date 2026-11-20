package one.scary.bellaclaw.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

// Material 3 scheme, violet and plum, from the seed colour #5E3A8C; tertiary is a dusky rose.
internal val LightColors = lightColorScheme(
    primary = Color(0xFF5E3A8C),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFE9DBFF),
    onPrimaryContainer = Color(0xFF200646),
    secondary = Color(0xFF67597A),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFEADDF3),
    onSecondaryContainer = Color(0xFF231A2D),
    tertiary = Color(0xFF7D4E63),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFFFD8E7),
    onTertiaryContainer = Color(0xFF31101F),
    error = Color(0xFFBA1A1A),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    background = Color(0xFFFDF7FF),
    onBackground = Color(0xFF1D1A22),
    surface = Color(0xFFFDF7FF),
    onSurface = Color(0xFF1D1A22),
    surfaceVariant = Color(0xFFE8E0EB),
    onSurfaceVariant = Color(0xFF4A4455),
    outline = Color(0xFF7B7486),
    outlineVariant = Color(0xFFCDC3D8),
    scrim = Color(0xFF000000),
    inverseSurface = Color(0xFF322F37),
    inverseOnSurface = Color(0xFFF5EFF7),
    inversePrimary = Color(0xFFD5BBFF),
    surfaceDim = Color(0xFFDED8E0),
    surfaceBright = Color(0xFFFDF7FF),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF7F1FA),
    surfaceContainer = Color(0xFFF3ECF8),
    surfaceContainerHigh = Color(0xFFEDE5F3),
    surfaceContainerHighest = Color(0xFFE6E0EA),
)

internal val DarkColors = darkColorScheme(
    primary = Color(0xFFD5BBFF),
    onPrimary = Color(0xFF3B1E68),
    primaryContainer = Color(0xFF4A2A78),
    onPrimaryContainer = Color(0xFFE9DBFF),
    secondary = Color(0xFFCEC0E0),
    onSecondary = Color(0xFF362B44),
    secondaryContainer = Color(0xFF4D415B),
    onSecondaryContainer = Color(0xFFEADDF3),
    tertiary = Color(0xFFEFB5CC),
    onTertiary = Color(0xFF4A2235),
    tertiaryContainer = Color(0xFF63384B),
    onTertiaryContainer = Color(0xFFFFD8E7),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF151218),
    onBackground = Color(0xFFE7E0EA),
    surface = Color(0xFF151218),
    onSurface = Color(0xFFE7E0EA),
    surfaceVariant = Color(0xFF4A4455),
    onSurfaceVariant = Color(0xFFCDC3D8),
    outline = Color(0xFF968DA1),
    outlineVariant = Color(0xFF4A4455),
    scrim = Color(0xFF000000),
    inverseSurface = Color(0xFFE7E0EA),
    inverseOnSurface = Color(0xFF322F37),
    inversePrimary = Color(0xFF5E3A8C),
    surfaceDim = Color(0xFF151218),
    surfaceBright = Color(0xFF3C3840),
    surfaceContainerLowest = Color(0xFF100D13),
    surfaceContainerLow = Color(0xFF1D1A22),
    surfaceContainer = Color(0xFF221E26),
    surfaceContainerHigh = Color(0xFF2C2831),
    surfaceContainerHighest = Color(0xFF37333C),
)

/** Colours the Material scheme has no role for. */
data class ExtraColors(val online: Color)

internal val LightExtraColors = ExtraColors(online = Color(0xFF2FBF71))
internal val DarkExtraColors = ExtraColors(online = Color(0xFF5FD99A))
