package one.scary.bellaclaw.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.components.text

/** The signed-in account and its server, and Sign out with its failure. */
@Composable
fun AccountSection(state: SettingsUiState, onSignOut: () -> Unit) {
    SectionHeader(stringResource(R.string.account_title))
    ListItem(
        headlineContent = { Text(state.username) },
        supportingContent = { Text(state.serverUrl) },
        leadingContent = { Icon(Icons.Outlined.AccountCircle, contentDescription = null) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
    ListItem(
        headlineContent = { Text(stringResource(R.string.sign_out)) },
        supportingContent = {
            val error = state.signOutError
            if (error != null) {
                Text(error.text(), color = MaterialTheme.colorScheme.error)
            } else {
                Text(stringResource(R.string.sign_out_summary))
            }
        },
        leadingContent = { Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null) },
        trailingContent = if (state.isSigningOut) {
            { CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp) }
        } else {
            null
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(enabled = !state.isSigningOut, onClick = onSignOut),
    )
}
