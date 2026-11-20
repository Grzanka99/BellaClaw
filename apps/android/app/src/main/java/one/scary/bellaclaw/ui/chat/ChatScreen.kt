package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.Author
import one.scary.bellaclaw.model.ChatKind
import one.scary.bellaclaw.model.Message
import one.scary.bellaclaw.model.SendState
import one.scary.bellaclaw.ui.theme.BellaClawTheme
import java.time.Instant
import java.time.ZoneId

@Composable
fun ChatScreen(
    state: ChatUiState,
    onBack: () -> Unit,
    onDraftChange: (String) -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: () -> Unit,
    onSend: () -> Unit,
    onOpenModelPicker: () -> Unit,
    onRetry: (String) -> Unit,
    onLoadOlder: () -> Unit,
    pickerEvents: ModelPickerEvents,
    thumbnailLoader: ThumbnailLoader,
    modifier: Modifier = Modifier,
) {
    val isBellaClaw = state.kind == ChatKind.BELLACLAW
    Scaffold(
        modifier = modifier,
        topBar = {
            if (isBellaClaw) {
                BellaClawTopBar(isStreamOpen = state.isStreamOpen, onBack = onBack)
            } else {
                PlainChatTopBar(
                    title = state.title ?: stringResource(R.string.new_chat_title),
                    onBack = onBack,
                    onOpenModelPicker = onOpenModelPicker,
                )
            }
        },
        bottomBar = {
            Composer(
                draft = state.draft,
                placeholder = if (isBellaClaw) {
                    stringResource(R.string.composer_hint_bellaclaw)
                } else {
                    stringResource(R.string.composer_hint_chat)
                },
                attachmentUri = state.attachmentUri,
                canSend = state.canSend,
                onDraftChange = onDraftChange,
                onAttach = onAttach,
                onRemoveAttachment = onRemoveAttachment,
                onSend = onSend,
                thumbnailLoader = thumbnailLoader,
                modifier = Modifier.navigationBarsPadding().imePadding(),
            )
        },
    ) { padding ->
        MessageList(
            rows = state.rows,
            isTyping = state.isTyping,
            assistantInBubbles = isBellaClaw,
            onRetry = onRetry,
            onLoadOlder = onLoadOlder,
            modifier = Modifier.padding(padding),
        )
    }
    state.picker?.let { picker ->
        ModelPickerSheet(state = picker, events = pickerEvents)
    }
}

private val noPickerEvents = ModelPickerEvents({ _, _ -> }, {}, {}, {}, {})
private val noThumbnails = ThumbnailLoader { null }

@Preview
@Composable
private fun BellaClawChatPreview() {
    val now = Instant.now()
    BellaClawTheme {
        ChatScreen(
            state = ChatUiState(
                kind = ChatKind.BELLACLAW,
                rows = chatRows(
                    listOf(
                        Message("1", "b", Author.ASSISTANT, "Staging is live. Smoke tests passed.", now),
                        Message("2", "b", Author.USER, "Ship to prod tomorrow 9:00", now, sendState = SendState.PENDING),
                    ),
                    ZoneId.systemDefault(),
                ),
                isTyping = true,
                isStreamOpen = true,
                isConversationKnown = true,
            ),
            onBack = {},
            onDraftChange = {},
            onAttach = {},
            onRemoveAttachment = {},
            onSend = {},
            onOpenModelPicker = {},
            onRetry = {},
            onLoadOlder = {},
            pickerEvents = noPickerEvents,
            thumbnailLoader = noThumbnails,
        )
    }
}

@Preview
@Composable
private fun PlainChatPreview() {
    val now = Instant.now()
    BellaClawTheme {
        ChatScreen(
            state = ChatUiState(
                title = "Kotlin flow vs channel",
                rows = chatRows(
                    listOf(
                        Message("1", "k", Author.USER, "When should I use Channel instead of SharedFlow?", now),
                        Message("2", "k", Author.ASSISTANT, "Use a Channel when each event must be handled once.", now),
                    ),
                    ZoneId.systemDefault(),
                ),
                isConversationKnown = true,
            ),
            onBack = {},
            onDraftChange = {},
            onAttach = {},
            onRemoveAttachment = {},
            onSend = {},
            onOpenModelPicker = {},
            onRetry = {},
            onLoadOlder = {},
            pickerEvents = noPickerEvents,
            thumbnailLoader = noThumbnails,
        )
    }
}
