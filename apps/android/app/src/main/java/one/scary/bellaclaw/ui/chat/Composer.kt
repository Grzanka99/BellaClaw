package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import one.scary.bellaclaw.R

/** The message box: attach button, text, the picked image above them, and the send button. */
@Composable
fun Composer(
    draft: String,
    placeholder: String,
    attachmentUri: String?,
    canSend: Boolean,
    onDraftChange: (String) -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: () -> Unit,
    onSend: () -> Unit,
    thumbnailLoader: ThumbnailLoader,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.weight(1f),
        ) {
            Column {
                attachmentUri?.let { uri ->
                    AttachmentPreview(uri = uri, loader = thumbnailLoader, onRemove = onRemoveAttachment)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onAttach, modifier = Modifier.padding(start = 4.dp)) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.action_attach_image))
                    }
                    TextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        placeholder = { Text(placeholder) },
                        maxLines = 5,
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                        ),
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        FilledIconButton(
            onClick = onSend,
            enabled = canSend,
            modifier = Modifier.size(56.dp),
            colors = IconButtonDefaults.filledIconButtonColors(),
        ) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.action_send))
        }
    }
}

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
