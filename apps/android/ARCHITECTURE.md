# BellaClaw Android: architecture rules

Google's recommended app architecture with unidirectional data flow, sized for a small app. One `app`
module; every dependency and plugin version lives in `gradle/libs.versions.toml`.

## Layers

`ui` → `data` → `model`. A layer imports only the layers to its right, never the reverse.

| Package (`one.scary.bellaclaw.…`) | Holds |
| --- | --- |
| `model` | Plain Kotlin types (`Chat`, `Message`, `ModelChoice`, `ModelSettings`, `Personality`, `SettingsSnapshot`, …). No Android or Compose imports. |
| `data` | One repository per kind of data: `ChatRepository` (chats, messages, typing, stream state), `SettingsRepository` (one `SettingsSnapshot` flow: providers, models, personality, theme). |
| `data.sample` | The in-memory sample data the repositories start from. Only `data` and previews read it. |
| `ui.<feature>` | `home`, `chat`, `settings`, `settings.models`, `settings.personality`, `settings.theme`. |
| `ui.components` | Composables and label mappings used by more than one feature. |
| `ui.theme` | Colour schemes, extra colour tokens, typography, `BellaClawTheme`. |
| `ui.navigation` | Typed destinations and the one `NavHost`. |
| `ui` (root) | `MainActivity`, `AppViewModel` (theme), `appContainer()` for factories. |
| root | `BellaClawApplication` and `AppContainer` (wiring only). |

No domain/use-case layer: add one only for logic that two ViewModels share.

## Files of a screen

Each screen has one file per concern:

- `XUiState.kt`: an immutable `data class`, with defaults that render an empty screen.
- `XViewModel.kt`: exposes exactly one `StateFlow<XUiState>` (`stateIn(viewModelScope, WhileSubscribed(5_000), …)`) and takes events as functions. It owns screen-only state in private `MutableStateFlow`s combined with repository flows. Text drafts (the composer, the personality) live in `SavedStateHandle.getMutableStateFlow` so they survive process death (the composer draft comes back only for a chat that still exists after the restart; a chat created in memory is gone); open sheets, editors and a picked image do not. It has a `Factory` in its companion.
- `XRoute.kt`: obtains the ViewModel (`viewModel(factory = XViewModel.Factory)`), collects state with `collectAsStateWithLifecycle`, and wires events. Platform calls (pickers, intents) live here.
- `XScreen.kt`: the stateless content composable `XScreen(state, event lambdas…)`, plus its `@Preview`s.
- Sheets, rows and bars of one feature go in their own files in that feature's package, and so do pure
  mappers the ViewModel uses to shape UI state (e.g. `chatRows`: messages to display rows with day
  separators). Composables render and format with resources; they do not reshape data.

Split a file when it passes ~250 lines or holds unrelated composables.

## State and events

Repository `Flow` → ViewModel `combine` → `StateFlow<UiState>` → Route → Screen. Events go back as
lambdas → ViewModel function → repository `suspend` call or local state update. Composables hold no
business logic, never touch a repository, and never see the `NavController`. A one-shot result
(a chat was created, the personality was saved) is a field in the UI state; the Route acts on it in a
`LaunchedEffect` once its entry is resumed (`withResumed`), so the navigation is not dropped, and only
then tells the ViewModel it was handled. An event that starts such a result (New chat)
is ignored while one is pending.

A state that only lasts while the data says so (a chat id with no chat: `ChatUiState.isMissing`) is a
plain UI state field; the Route reacts to it (back to Home) without acknowledging it.

Settings screens and the chat's model picker build their state from the one `SettingsSnapshot`, never
from separately read settings flows, so the provider list always matches the selection.

No hard-coded colours, type sizes or user-visible strings in screens: use `MaterialTheme` tokens,
`BellaClawThemeTokens.extraColors` and `res/values/strings.xml`. Enum labels map to string
resources in `ui.components.Labels`.

## Navigation

Destinations are `@Serializable` types in `ui.navigation.Destinations`. `BellaClawNavHost` is the
only graph: it starts at Home and pushes the BellaClaw chat once, so Back from it lands on Home.
Screens get navigation as lambdas, and those lambdas act only while their back stack entry is
resumed, so taps during a transition push or pop once. The one exception is the missing-chat return
to Home, which a restored entry reports before it resumes. A destination's arguments reach its
ViewModel through the factory (`createSavedStateHandle().toRoute<…>()`); the ViewModel constructor
takes plain values plus, where it keeps drafts, that `SavedStateHandle`.

`MainActivity` sets the system bar icon appearance from the resolved app theme (`ThemeMode.isDark`)
whenever it changes, since the app theme can override the device theme.

## Wiring

`BellaClawApplication` creates one `AppContainer`, which creates each repository once. It also owns
one application-lifetime `CoroutineScope` and passes it to repositories whose work must outlive a
screen (`ChatRepository`: the sample typing timer, one per chat, restarted on each send). ViewModel
factories read it through `CreationExtras.appContainer()`. No DI framework. Repositories are concrete
classes; add an interface only when a second implementation exists.

## Tests

JVM unit tests in `app/src/test` for every ViewModel: construct it with real repositories, collect
its state (`collectIn`), send events, assert the exposed state. `MainDispatcherRule` replaces
`Dispatchers.Main`; repositories that take a scope get the test's `backgroundScope`, and a fixed
`Clock` where dates matter.

## Extension points

Later chunks change repository internals, not their public `Flow`/`suspend` surface, so ViewModels
stay as they are:

- Networking (server URL, sign-in, history, sends, the live stream): an HTTP/stream client in
  `data` (e.g. `data.remote`), created in `AppContainer` and passed to the repositories. It
  replaces `data.sample`, `ChatRepository.isStreamOpen`, `isTyping` and the sample typing timer.
  Network writes that must finish after the screen is gone run in the application scope the
  repositories already receive.
- Storage (settings, session, cached history): a local store in `data` (e.g. `data.local`) behind
  the same repositories.
- Push: a messaging service at the app root that hands decrypted messages to `ChatRepository`;
  Keystore code lives in `data`.
- Images: upload goes through `ChatRepository.send`; the UI already passes a content URI. Thumbnails
  are decoded by a `ThumbnailLoader` the chat Route builds on the `ContentResolver`; `ImageThumbnail`
  only shows the result for its current URI.
