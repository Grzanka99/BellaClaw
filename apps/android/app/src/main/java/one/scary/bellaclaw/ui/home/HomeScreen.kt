package one.scary.bellaclaw.ui.home

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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
        LazyColumn(contentPadding = PaddingValues(bottom = 96.dp), modifier = Modifier.padding(padding)) {
            state.bellaClaw?.let { bellaClaw ->
                item(key = bellaClaw.id) {
                    BellaClawRow(summary = bellaClaw, onClick = { onOpenChat(bellaClaw.id) })
                    HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                }
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

@Preview
@Composable
private fun HomeScreenPreview() {
    val now = Instant.now()
    BellaClawTheme {
        HomeScreen(
            state = HomeUiState(
                bellaClaw = BellaClawSummary("bellaclaw", "Reminder set for 18:00", now),
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
