package one.scary.bellaclaw.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** A small filled dot of [color]. */
@Composable
fun Dot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier = modifier.size(8.dp).background(color, CircleShape))
}
