package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import one.scary.bellaclaw.R

/** Decodes a thumbnail from a content URI; null when it cannot. The chat Route supplies it. */
fun interface ThumbnailLoader {
    suspend fun load(uri: String): ImageBitmap?
}

/** A thumbnail decoded for exactly [uri]. */
private class Thumbnail(val uri: String, val bitmap: ImageBitmap?)

/** A picked image, decoded as a thumbnail by [loader]. A plain box until the image of the current [uri] loads. */
@Composable
fun ImageThumbnail(uri: String, loader: ThumbnailLoader, modifier: Modifier = Modifier) {
    val thumbnail by produceState<Thumbnail?>(initialValue = null, uri, loader) {
        value = Thumbnail(uri, loader.load(uri))
    }
    val bitmap = thumbnail?.takeIf { it.uri == uri }?.bitmap
    if (bitmap == null) {
        ImagePlaceholder(modifier)
    } else {
        Image(
            bitmap = bitmap,
            contentDescription = stringResource(R.string.attached_image),
            contentScale = ContentScale.Crop,
            modifier = modifier,
        )
    }
}

/** The plain box an image shows while it has no picture. */
@Composable
fun ImagePlaceholder(modifier: Modifier = Modifier) {
    Box(modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant))
}
