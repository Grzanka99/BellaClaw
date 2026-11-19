package one.scary.bellaclaw.ui.settings.personality

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R
import one.scary.bellaclaw.ui.components.BackButton
import one.scary.bellaclaw.ui.components.SectionHeader
import one.scary.bellaclaw.ui.theme.BellaClawTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonalityScreen(
    state: PersonalityUiState,
    onBack: () -> Unit,
    onSave: () -> Unit,
    onBellaClawChange: (String) -> Unit,
    onUseInChatsChange: (Boolean) -> Unit,
    onChatsChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.personality_title)) },
                navigationIcon = { BackButton(onBack) },
                actions = {
                    TextButton(onClick = onSave, enabled = state.canSave) {
                        Text(stringResource(R.string.action_save))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .verticalScroll(rememberScrollState()),
        ) {
            SectionHeader(stringResource(R.string.bellaclaw_name))
            OutlinedTextField(
                value = state.bellaClaw,
                onValueChange = onBellaClawChange,
                label = { Text(stringResource(R.string.personality_bellaclaw_label)) },
                minLines = 4,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )
            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp))
            SectionHeader(stringResource(R.string.home_chats))
            ListItem(
                headlineContent = { Text(stringResource(R.string.personality_use_in_chats)) },
                supportingContent = {
                    if (state.useInChats) {
                        Text(stringResource(R.string.personality_use_in_chats_on))
                    } else {
                        Text(stringResource(R.string.personality_use_in_chats_off))
                    }
                },
                trailingContent = { Switch(checked = state.useInChats, onCheckedChange = null) },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                modifier = Modifier.toggleable(
                    value = state.useInChats,
                    onValueChange = onUseInChatsChange,
                    role = Role.Switch,
                ),
            )
            OutlinedTextField(
                value = state.chats,
                onValueChange = onChatsChange,
                label = { Text(stringResource(R.string.personality_chats_label)) },
                placeholder = {
                    Text(stringResource(R.string.personality_chats_placeholder), fontStyle = FontStyle.Italic)
                },
                supportingText = {
                    if (state.useInChats) {
                        Text(stringResource(R.string.personality_chats_help_on))
                    } else {
                        Text(stringResource(R.string.personality_chats_help_off))
                    }
                },
                minLines = 3,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )
        }
    }
}

@Preview
@Composable
private fun PersonalityScreenPreview() {
    BellaClawTheme {
        PersonalityScreen(
            state = PersonalityUiState("You are BellaClaw.", useInChats = false, chats = "", canSave = true),
            onBack = {},
            onSave = {},
            onBellaClawChange = {},
            onUseInChatsChange = {},
            onChatsChange = {},
        )
    }
}
