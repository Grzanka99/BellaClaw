# BellaClaw Android: architecture rules

Google's recommended app architecture with unidirectional data flow, sized for a small app. One `app`
module; every dependency and plugin version lives in `gradle/libs.versions.toml`.

## Layers

`ui` → `data` → `model`. A layer imports only the layers to its right, never the reverse.

| Package (`one.scary.bellaclaw.…`) | Holds |
| --- | --- |
| `model` | Plain Kotlin types (`Chat`, `Message`, `ModelChoice`, `ModelSettings`, `AiModel`, `Personality`, `SettingsSnapshot`, `Loadable`, `Session`, `LoginLink`, `PendingLink`, `LinkStatus`, `AccountError`, …), and every type a ViewModel gets from a repository. No Android or Compose imports. |
| `data` | One repository per kind of data: `ChatRepository` (chats, messages, typing, stream state), `SettingsRepository` (one `SettingsSnapshot` flow: the account's models and personality from the server, the phone's theme), `AccountRepository` (the session, sign-in, sign-out, the pending login link). `ServerUrls.kt`: the server address rule and the login link parser. |
| `data.remote` | `ApiClient`, the one HTTP client of the gateway's app API (OkHttp, kotlinx.serialization JSON), its request and answer bodies (one file per area: `ApiBodies.kt`, `DeviceBodies.kt`, `SettingsBodies.kt`), and `ApiResult`. |
| `data.push` | `PushRepository` (device registration, decrypted pushes as a flow), the device keys (`loadDeviceKeys`, `DeviceKeys`), RFC 8291 decryption (`decryptPush`), `PushTokens` (FCM's token, `FirebasePushTokens`). |
| `data.local` | `SessionStore`: the server address, session token and username in one app-private file. `ThemeStore`: the theme mode and Dynamic color in another. |
| `data.sample` | The in-memory sample chats `ChatRepository` starts from. Only `data` and previews read it. |
| `ui.<feature>` | `signin`, `home`, `chat`, `settings`, `settings.models`, `settings.personality`, `settings.theme`. |
| `ui.components` | Composables and label mappings used by more than one feature. |
| `ui.theme` | Colour schemes, extra colour tokens, typography, `BellaClawTheme`. |
| `ui.navigation` | Typed destinations and the two `NavHost`s. |
| `ui` (root) | `MainActivity`, `AppViewModel` (theme, signed in or not, a waiting login link), `appContainer()` for factories. |
| root | `BellaClawApplication` and `AppContainer` (wiring only), `PushService` (FCM's entry point). |

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

Destinations are `@Serializable` types in `ui.navigation.Destinations`. `MainActivity` shows one of
two graphs: `SignInNavHost` while signed out (sign-in, create account) and `BellaClawNavHost` while
signed in. Switching graphs drops the other's back stack, so a session that starts or ends (sign-in,
sign-out, a `401`) leaves nothing to go back to. `BellaClawNavHost` starts at Home and pushes the
BellaClaw chat once, so Back from it lands on Home. Both graphs hold the login link confirmation
(`LinkDestination`, no arguments) and push it whenever a link starts waiting (`PendingLinkEffect`);
every way out of it (Cancel, Done, Back) dismisses the link, and the screen closes once its link no longer waits.
Screens get navigation as lambdas, and those lambdas act only while their back stack entry is
resumed, so taps during a transition push or pop once. The one exception is the missing-chat return
to Home, which a restored entry reports before it resumes. A destination's arguments reach its
ViewModel through the factory (`createSavedStateHandle().toRoute<…>()`); the ViewModel constructor
takes plain values plus, where it keeps drafts, that `SavedStateHandle`.

`MainActivity` sets the system bar icon appearance from the resolved app theme (`ThemeMode.isDark`)
whenever it changes, since the app theme can override the device theme.

## Account and networking

- Only repositories call `ApiClient`; ViewModels see `AccountError` and model types, never
  `ApiResult` or request bodies. Every request carries `X-BellaClaw-Client: app`; a POST or PUT carries a
  JSON body with a `Content-Length`. `post` goes to a server named by the caller (sign-in, link check);
  `getSignedIn`, `postSignedIn`, `putSignedIn` and `deleteSignedIn` go to the session's server with
  `Authorization: Bearer <token>`. `ApiClient` builds
  its one OkHttp client: it follows no redirect (a redirect answer is an API error like any other
  non-2xx, so no body with a password or token is replayed elsewhere), and its read timeout (70 s)
  covers the server's longest wait (a link request waits up to 60 s for the assistant).
- A model change (`PUT /api/model`) waits while the assistant verifies the model with the provider,
  minutes at worst: it alone goes through `putSignedInLongWait`, a second OkHttp client built from the
  first with a 270 s read timeout, past the gateway's 250 s wait for the assistant and its 255 s idle timeout.
- The session lives only in `SessionStore` (`files/session.json`, written through
  `session.json.tmp`; both are excluded from cloud backup and device transfer by
  `res/xml/data_extraction_rules.xml`). It is read once when the store is
  created, so the app starts in the right graph; `AccountRepository.session` is its flow.
- A `401` on any signed-in request ends the session in `ApiClient` itself (only if the session still
  has that request's token). The session flow turns null, `AppViewModel` reports signed out and
  `MainActivity` swaps to the sign-in graph. Sign-out ends the session after the server's `ok` or
  its `401`; any other failure keeps it.
- Server addresses pass `checkServerUrl`: trimmed, absolute, no trailing slash, no default port, a
  port in 1–65535, `https://`, and `http://` only in a debug build (`BuildConfig.DEBUG`), which alone allows cleartext traffic
  (`src/debug/AndroidManifest.xml`).
- A login link (`bellaclaw://login?server=…&token=…`, from an intent or a pasted code) is held in
  memory by `AccountRepository.pendingLink`. One link at a time: a link that arrives while one waits
  is dropped. A confirmation (`LinkViewModel`) belongs to the link that waited when it was created; its
  first state is already that link's step, and its actions and answers concern that link only. It
  shows the link's server and sends nothing before the user continues; then `POST /api/link/check`
  names the link's chat (`chatKey`, shown as channel and address), which the screen shows before any
  action that signs in, registers or connects. Signed in on another server, nothing is sent. The link
  is lost with the process, and the restored confirmation closes.
- Never log, `toString`, or put in saved state a token, a password, an activation code or a link:
  `Session`, `LoginLink` and the sign-in UI states leave them out of `toString`, request bodies
  holding them are plain classes, and sign-in ViewModels keep them in plain `MutableStateFlow`s.

## Push

FCM is only a wake-up channel carrying ciphertext: the app uses `firebase-messaging` and nothing
else from Firebase; the manifest turns off Firebase's default data collection and keeps messaging's own token making on.

- Keys: a P-256 key pair in the Android Keystore (alias `push`, purpose agree-key; the private key
  never leaves it) and a 16-byte auth secret in `files/push_auth_secret`, excluded from cloud backup
  and device transfer. Made on first use and kept for the install; when either is missing (a restored
  phone) both are made anew and the next registration sends them.
- Registration: `PushRepository` sends `PUT /api/device` (`DeviceBody`: FCM token, public key and
  auth secret, base64url) whenever a session starts (sign-in, or app start with a session) and
  whenever FCM gives a new token (`PushService.onNewToken`), if there is a session and a token. A
  failed registration is sent again at the next of those moments. Registration and sign-out
  hold one `Mutex` from `AppContainer`, so the device never registers while signing out; the server
  unregisters the device as part of logout. Once a session ends (sign-out or a `401`), the FCM token
  is deleted; the next sign-in gets a new one.
- Receiving: `PushService` (not exported) takes the data field `ciphertext` and hands it to
  `PushRepository.receive`, which decrypts it (`decryptPush`: RFC 8291, `aes128gcm`, one record) into
  `AppPush` and queues it on `pushes` (one collector; kept until collected). A message that arrives
  signed out, or does not decrypt or parse, is dropped, and one still waiting when its session is no
  longer the session is dropped when its turn comes.
- Off without Firebase: the Google services plugin is applied only when `app/google-services.json`
  exists (gitignored, never committed). Without it, or without Google Play services, `FirebasePushTokens`
  gives no token and push is simply off.
- Never log a push payload, a key, the auth secret or an FCM token; `DeviceBody` is a plain class.
- Test seams: `DeviceKeys.agree` (the ECDH step, so JVM tests use a software key) and `PushTokens`.

## Settings

- `SettingsSnapshot` holds the account's `models` and `personality` as `Loadable` (loading until the
  first answer, then loaded or failed with an `AccountError`) and the `theme`. Settings screens show
  a loading state, then the settings, or the error with Retry (`LoadingContent`, `LoadFailedContent`).
  Previews build small values inline.
- `SettingsRepository` watches the session from its construction: when one starts (a new token) it
  drops what it held and loads `GET /api/model` and `GET /api/personality`; when it ends (sign-out,
  a `401`) it drops them back to loading. The theme stays. An answer is applied only while the
  session that asked is still current. The Models screen reloads the models when it opens; no
  reload starts while a model change is verified, and a reload's answer is dropped when a change
  started after it did.
- `ModelSettings` is the server's model state: the active provider of `providers` (ids), a
  `RoleModel` per role (model id, effort or null for the model's default) and the active provider's
  `AiModel`s with the efforts each supports. The server's purposes and efforts map in `SettingsMapping.kt`. `SettingsSnapshot.providers`,
  the chat's model picker list, holds the active provider and its model ids once loaded.
- A model change (provider, a role's model and effort, a role's reset) runs in the application
  scope, so leaving the screen does not drop it. While it is verified, `isChangingModels` is set and
  no second change starts; the answer replaces the models, a refusal leaves them and sets
  `modelsChangeError` to the server's text, which stays through reloads until the next change
  starts. A role change sends only what differs from the server's current selection; an effort the
  newly picked model lacks falls back to the model's default. New models that lack the open role
  sheet's model, or its effort, close the sheet; the sheet labels any effort, so no value the
  catalog lacks breaks it.
- The personality saves with `PUT /api/personality` (all three fields) from the screen's scope; a
  refusal keeps the draft and shows the server's text. The fields take no input while the save runs
  and, after a success, until the screen has closed. The theme is written to `files/theme.json`
  (through `theme.json.tmp`) and read once when the store is created, so the first frame has it.

## Wiring

`BellaClawApplication` creates one `AppContainer` on first use, which creates the `SessionStore`,
the `ApiClient` and each repository once. It also owns
one application-lifetime `CoroutineScope` and passes it to repositories whose work must outlive a
screen (`ChatRepository`: the sample typing timer, one per chat, restarted on each send;
`SettingsRepository`: the session watch and model changes). ViewModel
factories read it through `CreationExtras.appContainer()`. No DI framework. Repositories are concrete
classes; add an interface only when a second implementation exists.

## Tests

JVM unit tests in `app/src/test` for every ViewModel: construct it with real repositories, collect
its state (`collectIn`), send events, assert the exposed state. Account tests use `TestServer`: a
local `MockWebServer` plus the real `SessionStore`, `ApiClient` and `AccountRepository` on a session
file in a temporary folder; a network answer reaches the ViewModel on OkHttp's thread, so after any event that follows one
they wait with `uiState.first { … }` for the state the outcome names (an error, a step), not for a
loading flag to clear, and read `uiState.value` only before the first request. `MainDispatcherRule` replaces
`Dispatchers.Main`; repositories that take a scope get the test's `backgroundScope`, and a fixed
`Clock` where dates matter.

Push tests run the whole decryption with a software P-256 key (`DeviceKeys.agree`) against the RFC 8291
Appendix A vector and messages encrypted as the server does, and replace `PushTokens` with a fake.

`TestServer.settingsRepository` adds the real `SettingsRepository`, with a `ThemeStore` that writes in
place and answers for the two settings reads. `route` answers one method and path every time, so
concurrent requests get the right body whatever their order; `takeRequest(method, path)` skips the
others. A repository's work in `backgroundScope` runs only while the test suspends, so a test waits
with `first { … }` before a blocking `takeRequest`.

## Extension points

Later chunks change repository internals, not their public `Flow`/`suspend` surface, so ViewModels
stay as they are:

- Networking (history, sends, the live stream): `ApiClient` from `AppContainer`, passed to the
  repositories (OkHttp also reads the server-sent event stream). It replaces `data.sample`,
  `ChatRepository.isStreamOpen`, `isTyping` and the sample typing timer. Network writes that must
  finish after the screen is gone run in the application scope the repositories already receive.
- Storage (cached history): a local store in `data.local` behind the same repositories.
- Push notifications: collect `PushRepository.pushes` (see Push).
- Images: upload goes through `ChatRepository.send`; the UI already passes a content URI. Thumbnails
  are decoded by a `ThumbnailLoader` the chat Route builds on the `ContentResolver`; `ImageThumbnail`
  only shows the result for its current URI.
