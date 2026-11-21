package one.scary.bellaclaw.ui

import androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.Companion.APPLICATION_KEY
import androidx.lifecycle.viewmodel.CreationExtras
import one.scary.bellaclaw.AppContainer
import one.scary.bellaclaw.BellaClawApplication

/** The application's container, for ViewModel factories. */
fun CreationExtras.appContainer(): AppContainer {
    val application = this[APPLICATION_KEY]
    check(application is BellaClawApplication) { "ViewModels need BellaClawApplication" }
    return application.container
}
