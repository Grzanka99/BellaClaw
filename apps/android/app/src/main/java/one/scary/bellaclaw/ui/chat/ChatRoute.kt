package one.scary.bellaclaw.ui.chat

import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** [onChatMissing] runs when no chat has this screen's id, e.g. a restored screen of a chat the app no longer has. */
@Composable
fun ChatRoute(
    onBack: () -> Unit,
    onChatMissing: () -> Unit,
    viewModel: ChatViewModel = viewModel(factory = ChatViewModel.Factory),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(state.isMissing) {
        if (state.isMissing) {
            onChatMissing()
        }
    }
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            viewModel.onAttach(uri.toString())
        }
    }
    val contentResolver = LocalContext.current.contentResolver
    val thumbnailLoader = remember(contentResolver) {
        ThumbnailLoader { uri ->
            withContext(Dispatchers.IO) {
                runCatching {
                    contentResolver.loadThumbnail(uri.toUri(), Size(THUMBNAIL_PX, THUMBNAIL_PX), null).asImageBitmap()
                }.getOrNull()
            }
        }
    }
    ChatScreen(
        state = state,
        onBack = onBack,
        onDraftChange = viewModel::onDraftChange,
        onAttach = {
            pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        },
        onRemoveAttachment = viewModel::onRemoveAttachment,
        onSend = viewModel::send,
        onOpenModelPicker = viewModel::openModelPicker,
        onRetry = viewModel::retry,
        onLoadOlder = viewModel::loadOlder,
        pickerEvents = ModelPickerEvents(
            onProvider = viewModel::onPickerProvider,
            onModel = viewModel::onPickerModel,
            onEffort = viewModel::onPickerEffort,
            onDone = viewModel::confirmModelPicker,
            onDismiss = viewModel::dismissModelPicker,
        ),
        thumbnailLoader = thumbnailLoader,
    )
}

private const val THUMBNAIL_PX = 512
