package one.scary.bellaclaw.ui

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import one.scary.bellaclaw.BellaClawApplication
import one.scary.bellaclaw.ui.navigation.BellaClawNavHost
import one.scary.bellaclaw.ui.navigation.SignInNavHost
import one.scary.bellaclaw.ui.theme.BellaClawTheme
import one.scary.bellaclaw.ui.theme.isDark

class MainActivity : ComponentActivity() {
    private val appViewModel: AppViewModel by viewModels { AppViewModel.Factory }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A recreated activity saw its launch intent already.
        if (savedInstanceState == null) {
            handleLoginLink(intent)
        }
        setContent {
            val state by appViewModel.uiState.collectAsStateWithLifecycle()
            val theme = state.theme
            val dark = theme.mode.isDark()
            // System bar icons follow the app theme, which can differ from the device theme.
            DisposableEffect(dark) {
                val barStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark }
                enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)
                onDispose {}
            }
            BellaClawTheme(mode = theme.mode, dynamicColor = theme.dynamicColor) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    // Each graph starts fresh, so signing in or out leaves no back stack behind.
                    if (state.isSignedIn) {
                        BellaClawNavHost(hasPendingLink = state.hasPendingLink)
                    } else {
                        SignInNavHost(hasPendingLink = state.hasPendingLink)
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        (application as BellaClawApplication).container.foreground.value = true
    }

    /** A stop for a configuration change (a rotation) is not leaving the foreground: the next start follows at once. */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) {
            (application as BellaClawApplication).container.foreground.value = false
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLoginLink(intent)
    }

    private fun handleLoginLink(intent: Intent) {
        val link = intent.dataString
        if (intent.action == Intent.ACTION_VIEW && link != null) {
            appViewModel.onLoginLink(link)
        }
    }
}
