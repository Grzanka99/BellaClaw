package one.scary.bellaclaw.ui.components

import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLocale
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Date

/** Time of day in the user's 12/24-hour setting, e.g. "14:01". */
@Composable
fun formatTime(instant: Instant): String = DateFormat.getTimeFormat(LocalContext.current).format(Date.from(instant))

/** Chat-list timestamp: the time today, the weekday this week, the date before that. */
@Composable
fun formatListTime(instant: Instant): String {
    val zone = ZoneId.systemDefault()
    val date = instant.atZone(zone).toLocalDate()
    val today = LocalDate.now(zone)
    if (date == today) {
        return formatTime(instant)
    }
    if (date.isAfter(today.minusDays(7))) {
        return date.dayOfWeek.getDisplayName(TextStyle.SHORT, LocalLocale.current.platformLocale)
    }
    return date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT))
}
