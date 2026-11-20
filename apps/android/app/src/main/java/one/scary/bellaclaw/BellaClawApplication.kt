package one.scary.bellaclaw

import android.app.Application

class BellaClawApplication : Application() {
    val container by lazy { AppContainer(this) }
}
