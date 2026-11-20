package one.scary.bellaclaw.ui.home

import android.content.res.Configuration
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ChatIcon
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.theme.BellaClawTheme
import java.time.Instant

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    state: HomeUiState,
    onOpenChat: (String) -> Unit,
    onNewChat: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.home_title)) },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Outlined.Settings, contentDescription = stringResource(R.string.settings_title))
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNewChat,
                icon = { Icon(Icons.Outlined.EditNote, contentDescription = null) },
                text = { Text(stringResource(R.string.action_new_chat)) },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            if (state.newChatFailed) {
                Text(
                    stringResource(R.string.error_new_chat),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            LazyColumn(contentPadding = PaddingValues(bottom = 96.dp), modifier = Modifier.weight(1f)) {
                item(key = state.bellaClaw.id) {
                    BellaClawRow(
                        summary = state.bellaClaw,
                        onClick = { onOpenChat(state.bellaClaw.id) },
                        modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                    )
                }
                item {
                    SectionHeader(stringResource(R.string.home_chats))
                }
                items(state.chats, key = { it.id }) { chat ->
                    PlainChatRow(summary = chat, onClick = { onOpenChat(chat.id) })
                }
                item {
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
    }
}

@Preview
@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun HomeScreenPreview() {
    val now = Instant.now()
    BellaClawTheme {
        HomeScreen(
            state = HomeUiState(
                bellaClaw = BellaClawSummary("bellaclaw", "Reminder set for 18:00", now, isUnread = true),
                chats = listOf(
                    PlainChatSummary("a", "Kotlin flow vs channel", ChatIcon.CODE, "Use a SharedFlow when…", now, isUnread = true),
                    PlainChatSummary("b", null, ChatIcon.ROCKET, null, null),
                ),
            ),
            onOpenChat = {},
            onNewChat = {},
            onOpenSettings = {},
        )
    }
}
