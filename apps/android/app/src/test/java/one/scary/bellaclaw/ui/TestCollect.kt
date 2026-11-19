package one.scary.bellaclaw.ui

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher

/** Keeps a WhileSubscribed state flow active for the rest of the test. */
@OptIn(ExperimentalCoroutinesApi::class)
fun <T> TestScope.collectIn(flow: StateFlow<T>) {
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { flow.collect {} }
}
