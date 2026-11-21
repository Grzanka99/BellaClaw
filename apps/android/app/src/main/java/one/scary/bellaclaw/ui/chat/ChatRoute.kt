package one.scary.bellaclaw.ui.chat

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.util.Size
import android.widget.Toast
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import one.scary.bellaclaw.R

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
    val context = LocalContext.current
    val dictation = rememberDictation(onLanguagePicked = viewModel::onDictationLanguage) { heard, failure ->
        viewModel.onDraftChange(heard)
        val message = when (failure) {
            DictationFailure.LANGUAGE_UNAVAILABLE -> context.getString(R.string.error_dictation_language)
            DictationFailure.OTHER -> context.getString(R.string.error_dictation)
            null -> return@rememberDictation
        }
        Toast.makeText(context, message, Toast.LENGTH_LONG).show()
    }
    LaunchedEffect(state.dictationLanguage) {
        dictation.savedLanguage = state.dictationLanguage
    }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) {
        if (dictation.isListening) {
            dictation.stop()
        }
    }
    val askMicrophone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            dictation.start()
        }
    }
    val contentResolver = context.contentResolver
    val thumbnailLoader = remember(contentResolver) {
        ThumbnailLoader { uri ->
            withContext(Dispatchers.IO) {
                runCatching {
                    contentResolver.loadThumbnail(uri.toUri(), Size(THUMBNAIL_PX, THUMBNAIL_PX), null).asImageBitmap()
                }.getOrNull()
            }
        }
    }
    val imageLoader = remember(contentResolver, viewModel) {
        MessageImageLoader { image, maxPx ->
            val source = if (image.localUri != null) {
                ImageDecoder.createSource(contentResolver, image.localUri.toUri())
            } else {
                val file = image.mediaId?.let { viewModel.imageFile(it) } ?: return@MessageImageLoader null
                ImageDecoder.createSource(file)
            }
            withContext(Dispatchers.IO) {
                runCatching { decode(source, maxPx).asImageBitmap() }.getOrNull()
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
            onModel = viewModel::onPickerModel,
            onEffort = viewModel::onPickerEffort,
            onRetry = viewModel::retryModelPicker,
            onDone = viewModel::confirmModelPicker,
            onDismiss = viewModel::dismissModelPicker,
        ),
        thumbnailLoader = thumbnailLoader,
        imageLoader = imageLoader,
        onOpenImage = viewModel::openImage,
        onCloseImage = viewModel::closeImage,
        dictation = dictation,
        onDictate = {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                dictation.start()
            } else {
                askMicrophone.launch(Manifest.permission.RECORD_AUDIO)
            }
        },
    )
}

/** Decodes [source] with its longer side at most [maxPx], keeping its proportions. */
private fun decode(source: ImageDecoder.Source, maxPx: Int): Bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
    val longer = maxOf(info.size.width, info.size.height)
    if (longer > maxPx) {
        decoder.setTargetSize(
            (info.size.width.toLong() * maxPx / longer).toInt().coerceAtLeast(1),
            (info.size.height.toLong() * maxPx / longer).toInt().coerceAtLeast(1),
        )
    }
}

private const val THUMBNAIL_PX = 512
