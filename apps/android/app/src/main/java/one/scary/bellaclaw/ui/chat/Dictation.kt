package one.scary.bellaclaw.ui.chat

import android.content.Context
import android.content.Intent
import android.content.res.Resources
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.edit
import java.util.Locale

/** Why dictation stopped on its own. */
enum class DictationFailure { LANGUAGE_UNAVAILABLE, OTHER }

/**
 * Speech to text with the phone's speech service. It listens until [finish], [stop] or a failure: each
 * pause ends one recognition, whose text is kept, and listening starts again. When it ends, [onDone]
 * gets what was heard, with the failure if one ended it. The language starts as the phone's and then
 * stays the last one picked.
 */
@Stable
class Dictation(private val context: Context, private val onDone: (String, DictationFailure?) -> Unit) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The languages set in Android Settings, the phone's own first. */
    private val phoneLanguages: List<Locale> = Resources.getSystem().configuration.locales.let { list ->
        List(list.size()) { list[it] }
    }

    var language: Locale by mutableStateOf(
        prefs.getString(KEY_LANGUAGE, null)?.let(Locale::forLanguageTag) ?: phoneLanguages.first(),
    )
        private set

    /** What the language menu offers: the phone's languages, and the current one if it is no longer among them. */
    val languages: List<Locale>
        get() = if (language in phoneLanguages) {
            phoneLanguages
        } else {
            listOf(language) + phoneLanguages
        }

    var isListening by mutableStateOf(false)
        private set

    private var isFinishing = false
    private var heard by mutableStateOf("")
    private var hearing by mutableStateOf("")

    /** Everything recognized so far, with the part still being heard. */
    val text: String
        get() = listOf(heard, hearing).filter { it.isNotEmpty() }.joinToString(" ")

    /** Recent loudness, each 0 to 1, oldest first. */
    val levels = mutableStateListOf<Float>()

    private var recognizer: SpeechRecognizer? = null

    fun start() {
        heard = ""
        hearing = ""
        levels.clear()
        isListening = true
        listen()
    }

    /** Listening restarts in [locale]; what was heard stays. */
    fun switchLanguage(locale: Locale) {
        if (isFinishing) {
            return
        }
        language = locale
        prefs.edit { putString(KEY_LANGUAGE, locale.toLanguageTag()) }
        keepHearing()
        listen()
    }

    /** Stops listening and ends once the speech service has recognized what was said last. */
    fun finish() {
        if (isFinishing) {
            return
        }
        isFinishing = true
        recognizer?.stopListening()
    }

    /** Ends now, with the last words as heard so far. */
    fun stop() {
        end(null)
    }

    fun release() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun end(failure: DictationFailure?) {
        val result = text
        isListening = false
        isFinishing = false
        recognizer?.cancel()
        heard = ""
        hearing = ""
        onDone(result, failure)
    }

    private fun keepHearing() {
        heard = text
        hearing = ""
    }

    private fun listen() {
        val current = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also {
            it.setRecognitionListener(listener)
            recognizer = it
        }
        current.cancel()
        current.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language.toLanguageTag())
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true),
        )
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResults(partialResults: Bundle) {
            hearing = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: hearing
        }

        override fun onResults(results: Bundle) {
            hearing = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: hearing
            keepHearing()
            if (isFinishing) {
                end(null)
            } else if (isListening) {
                listen()
            }
        }

        override fun onError(error: Int) {
            if (!isListening) {
                return
            }
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                keepHearing()
                if (isFinishing) {
                    end(null)
                } else {
                    listen()
                }
                return
            }
            val failure = if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) {
                DictationFailure.LANGUAGE_UNAVAILABLE
            } else {
                DictationFailure.OTHER
            }
            end(failure)
        }

        override fun onRmsChanged(rmsdB: Float) {
            levels.add(((rmsdB - QUIET_DB) / (LOUD_DB - QUIET_DB)).coerceIn(0f, 1f))
            if (levels.size > LEVEL_COUNT) {
                levels.removeAt(0)
            }
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    companion object {
        const val LEVEL_COUNT = 32
        private const val PREFS = "dictation"
        private const val KEY_LANGUAGE = "language"

        // The range the speech service reports loudness in, roughly.
        private const val QUIET_DB = -2f
        private const val LOUD_DB = 10f
    }
}

@Composable
fun rememberDictation(onDone: (String, DictationFailure?) -> Unit): Dictation {
    val context = LocalContext.current
    val currentOnDone by rememberUpdatedState(onDone)
    val dictation = remember(context) { Dictation(context) { heard, failure -> currentOnDone(heard, failure) } }
    DisposableEffect(dictation) {
        onDispose { dictation.release() }
    }
    return dictation
}
