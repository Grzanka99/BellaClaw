package one.scary.bellaclaw.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import one.scary.bellaclaw.R
import one.scary.bellaclaw.model.MessageImage

/**
 * Decodes a message's image, its longer side at most [maxPx]; null when there is no picture to show
 * (no `mediaId`, gone, or not reachable now). The chat Route supplies it.
 */
fun interface MessageImageLoader {
    suspend fun load(image: MessageImage, maxPx: Int): ImageBitmap?
}

/** A bitmap decoded for exactly [image]. */
private class Decoded(val image: MessageImage, val bitmap: ImageBitmap?)

/** [image] decoded by [loader] for a box of [maxPx]; null until it is, or when it has no picture. */
@Composable
private fun rememberDecoded(image: MessageImage, loader: MessageImageLoader, maxPx: Int): ImageBitmap? {
    val decoded by produceState<Decoded?>(initialValue = null, image, loader, maxPx) {
        value = Decoded(image, loader.load(image, maxPx))
    }
    return decoded?.takeIf { it.image == image }?.bitmap
}

/**
 * A message's image in its bubble, at most [MAX_SIZE] on each side with the picture's proportions; tapping
 * it calls [onOpen]. The plain placeholder while it loads and when it has no picture.
 */
@Composable
fun BubbleImage(image: MessageImage, loader: MessageImageLoader, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val bitmap = rememberDecoded(image, loader, with(LocalDensity.current) { MAX_SIZE.roundToPx() })
    val shape = RoundedCornerShape(12.dp)
    if (bitmap == null) {
        val description = stringResource(R.string.image)
        ImagePlaceholder(
            modifier = modifier
                .size(PLACEHOLDER_SIZE)
                .clip(shape)
                .semantics { contentDescription = description },
        )
    } else {
        Image(
            bitmap = bitmap,
            contentDescription = stringResource(R.string.image),
            contentScale = ContentScale.Crop,
            modifier = modifier
                .sizeIn(maxWidth = MAX_SIZE, maxHeight = MAX_SIZE)
                .aspectRatio(bitmap.width.toFloat() / bitmap.height)
                .clip(shape)
                .clickable(onClick = onOpen),
        )
    }
}

/** [image] on the whole screen, decoded for it; Back closes it with [onClose]. */
@Composable
fun ImageViewer(image: MessageImage, loader: MessageImageLoader, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val screen = LocalWindowInfo.current.containerSize
        val bitmap = rememberDecoded(image, loader, maxOf(screen.width, screen.height))
        Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.scrim), contentAlignment = Alignment.Center) {
            if (bitmap != null) {
                Image(
                    bitmap = bitmap,
                    contentDescription = stringResource(R.string.image),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

private val MAX_SIZE: Dp = 240.dp
private val PLACEHOLDER_SIZE: Dp = 180.dp
