package one.scary.bellaclaw.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

/**
 * Asks for the notification permission once the signed-in app shows, if it was never answered. Once
 * refused, Android reports a rationale and nothing asks again; Settings → Notifications still leads there.
 */
@Composable
fun AskNotificationPermission() {
    val activity = LocalActivity.current ?: return
    var asked by rememberSaveable { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        val permission = Manifest.permission.POST_NOTIFICATIONS
        val granted = activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        if (!asked && !granted && !activity.shouldShowRequestPermissionRationale(permission)) {
            asked = true
            launcher.launch(permission)
        }
    }
}
