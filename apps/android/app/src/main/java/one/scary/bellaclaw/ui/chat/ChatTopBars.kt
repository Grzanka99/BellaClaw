package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.components.BellaClawAvatar
import one.scary.bellaclaw.ui.components.OnlineDot
import one.scary.bellaclaw.ui.theme.BellaClawThemeTokens

/** BellaClaw's bar: back, avatar, name and the stream dot. No model control, no menu. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BellaClawTopBar(isStreamOpen: Boolean, onBack: () -> Unit) {
    TopAppBar(
        navigationIcon = { BackButton(onBack) },
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                BellaClawAvatar(size = 40.dp)
                Spacer(Modifier.width(12.dp))
                Text(stringResource(R.string.bellaclaw_name))
                if (isStreamOpen) {
                    Spacer(Modifier.width(8.dp))
                    OnlineDot(color = BellaClawThemeTokens.extraColors.online)
                }
            }
        },
    )
}

/** A plain chat's bar: back, title and the model control. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlainChatTopBar(title: String, onBack: () -> Unit, onOpenModelPicker: () -> Unit) {
    TopAppBar(
        navigationIcon = { BackButton(onBack) },
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        actions = {
            IconButton(onClick = onOpenModelPicker) {
                Icon(Icons.Outlined.Psychology, contentDescription = stringResource(R.string.action_choose_model))
            }
        },
    )
}
