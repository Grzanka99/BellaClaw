package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.ImageRefusal

/**
 * The message box: attach button, text, the picked image or why it was refused above them, and the send
 * button. An empty box has a mic ([onDictate]) instead of send; while [dictation] listens, the box
 * becomes [DictationBar]. Its surfaces float over the conversation as frosted glass from [hazeState].
 */
@Composable
fun Composer(
    draft: String,
    placeholder: String,
    attachmentUri: String?,
    attachmentRefusal: ImageRefusal?,
    canSend: Boolean,
    onDraftChange: (String) -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: () -> Unit,
    onSend: () -> Unit,
    thumbnailLoader: ThumbnailLoader,
    dictation: Dictation,
    onDictate: () -> Unit,
    hazeState: HazeState,
    modifier: Modifier = Modifier,
) {
    val focusRequester = remember { FocusRequester() }
    var focusAfterDictation by remember { mutableStateOf(false) }
    val finishDictation = { focus: Boolean ->
        focusAfterDictation = focus
        dictation.finish()
    }
    if (dictation.isListening) {
        DictationBar(
            dictation = dictation,
            onFinish = { finishDictation(false) },
            onEditText = { finishDictation(true) },
            hazeState = hazeState,
            modifier = modifier,
        )
        return
    }
    // Text put in from outside (dictation, a cleared box after sending) gets the cursor at its end.
    var field by remember { mutableStateOf(TextFieldValue(draft, TextRange(draft.length))) }
    val value = if (field.text == draft) {
        field
    } else {
        TextFieldValue(draft, TextRange(draft.length))
    }
    LaunchedEffect(focusAfterDictation) {
        if (focusAfterDictation) {
            focusRequester.requestFocus()
            focusAfterDictation = false
        }
    }
    val isEmpty = draft.isEmpty() && attachmentUri == null
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Surface(
            shape = BoxShape,
            color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = GLASS_ALPHA),
            modifier = Modifier.weight(1f).frosted(hazeState, BoxShape),
        ) {
            Column {
                attachmentUri?.let { uri ->
                    AttachmentPreview(uri = uri, loader = thumbnailLoader, onRemove = onRemoveAttachment)
                }
                attachmentRefusal?.let { reason ->
                    Text(
                        text = when (reason) {
                            ImageRefusal.TOO_LARGE -> stringResource(R.string.error_image_too_large)
                            ImageRefusal.UNSUPPORTED_TYPE -> stringResource(R.string.error_image_type)
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(start = 16.dp, top = 12.dp, end = 16.dp),
                    )
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    IconButton(onClick = onAttach, modifier = Modifier.padding(vertical = 4.dp)) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.action_attach_image))
                    }
                    val colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                    )
                    val interactionSource = remember { MutableInteractionSource() }
                    BasicTextField(
                        value = value,
                        onValueChange = {
                            field = it
                            onDraftChange(it.text)
                        },
                        textStyle = LocalTextStyle.current.merge(color = colors.focusedTextColor),
                        cursorBrush = SolidColor(colors.cursorColor),
                        maxLines = 5,
                        interactionSource = interactionSource,
                        modifier = Modifier
                            .weight(1f)
                            .defaultMinSize(minHeight = TextFieldDefaults.MinHeight)
                            .focusRequester(focusRequester),
                    ) { innerTextField ->
                        TextFieldDefaults.DecorationBox(
                            value = value.text,
                            innerTextField = innerTextField,
                            enabled = true,
                            singleLine = false,
                            visualTransformation = VisualTransformation.None,
                            interactionSource = interactionSource,
                            placeholder = { Text(placeholder) },
                            colors = colors,
                            contentPadding = TextFieldDefaults.contentPaddingWithoutLabel(start = 0.dp),
                        )
                    }
                    if (isEmpty) {
                        IconButton(
                            onClick = onDictate,
                            modifier = Modifier.padding(vertical = 4.dp),
                        ) {
                            Icon(Icons.Filled.Mic, contentDescription = stringResource(R.string.action_dictate))
                        }
                    }
                }
            }
        }
        if (!isEmpty) {
            Spacer(Modifier.width(8.dp))
            FilledIconButton(
                onClick = onSend,
                enabled = canSend,
                modifier = Modifier.size(56.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.action_send))
            }
        }
    }
}

private val BoxShape = RoundedCornerShape(28.dp)

@Composable
private fun AttachmentPreview(uri: String, loader: ThumbnailLoader, onRemove: () -> Unit) {
    Box(modifier = Modifier.padding(start = 12.dp, top = 12.dp, end = 12.dp)) {
        ImageThumbnail(
            uri = uri,
            loader = loader,
            modifier = Modifier
                .size(88.dp)
                .clip(RoundedCornerShape(16.dp)),
        )
        FilledTonalIconButton(
            onClick = onRemove,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(4.dp)
                .size(28.dp)
                .clip(CircleShape),
        ) {
            Icon(
                Icons.Filled.Close,
                contentDescription = stringResource(R.string.action_remove_image),
                modifier = Modifier.size(16.dp),
            )
        }
    }
}
