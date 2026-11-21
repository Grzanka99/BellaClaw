# BellaClaw Android: architecture rules

Google's recommended app architecture with unidirectional data flow, sized for a small app. One `app`
module; every dependency and plugin version lives in `gradle/libs.versions.toml`.

## Layers

`ui` → `data` → `model`. A layer imports only the layers to its right, never the reverse.

| Package (`one.scary.bellaclaw.…`) | Holds |
| --- | --- |
| `model` | Plain Kotlin types (`Chat`, `Message`, `ActivityStep`, `MessageImage`, `PickedImage`, `ImageCheck`, `SendState`, `ModelChoice`, `ModelSettings`, `AiModel`, `ChatProvider`, `Personality`, `SettingsSnapshot`, `Loadable`, `Session`, `LoginLink`, `PendingLink`, `LinkStatus`, `AccountError`, `AppPush`, `ChatNotification`, `TodoList`, `TodoItem`, `ListChange`, `FinishedList`, …), and every type a ViewModel gets from a repository. No Android or Compose imports. |
| `data` | One repository per kind of data: `ChatRepository` (chats, messages, sends and their images, typing, unread, the live stream; its state in `ChatState`; the live stream and its events in `ChatStream`; the list and history reads in `ChatSync`; sends in `ChatSends`; images in `ChatImages`), `SettingsRepository` (one `SettingsSnapshot` flow: the account's models and personality and the plain chats' model list from the server, the phone's theme), `AccountRepository` (the session, sign-in, sign-out, the pending login link), `ListsRepository` (the account's to-do lists and the app's changes to them). `ServerUrls.kt`: the server address rule and the login link parser. |
| `data.remote` | `ApiClient`, the one HTTP client of the gateway's app API (OkHttp, kotlinx.serialization JSON), its request and answer bodies (one file per area: `ApiBodies.kt`, `ChatBodies.kt` for conversations and the stream, `DeviceBodies.kt`, `SettingsBodies.kt`, `ListBodies.kt`), and `ApiResult`. |
| `data.push` | `PushRepository` (device registration, decrypted pushes as a flow), `PushNotifications` (a notification per push, behind the `Notifier` seam), the device keys (`loadDeviceKeys`, `DeviceKeys`), RFC 8291 decryption (`decryptPush`), `PushTokens` (FCM's token, `FirebasePushTokens`). |
| `data.local` | `SessionStore`: the server address, session token and username in one app-private file. `ThemeStore`: the theme mode and Dynamic color in another. `ChatStore`: per conversation, the model picked for a plain chat and the newest row seen; the model used last on this phone; the dictation language picked last; and the finished lists swiped away. `ImageCache`: history's images in the cache directory. `PickedImages`: reads a picked image, at most a given number of bytes (`ContentPickedImages`, on the `ContentResolver`). |
| `ui.<feature>` | `signin`, `home`, `chat`, `lists`, `settings`, `settings.models`, `settings.personality`, `settings.theme`. `chat` also holds `Dictation`, speech to text on the phone's `SpeechRecognizer`, which `ChatRoute` creates along with the microphone permission request. |
| `ui.components` | Composables and label mappings used by more than one feature. |
| `ui.theme` | Colour schemes, extra colour tokens, typography, `BellaClawTheme`. |
| `ui.navigation` | Typed destinations and the two `NavHost`s. |
| `ui` (root) | `MainActivity`, `AppViewModel` (theme, signed in or not, a waiting login link, the chat a tapped notification opens), `AskNotificationPermission`, `appContainer()` for factories. |
| root | `BellaClawApplication` and `AppContainer` (wiring only), `PushService` (FCM's entry point), `AndroidNotifier` (the notifications and their channels in Android). |

No domain/use-case layer: add one only for logic that two ViewModels share.

## Files of a screen

Each screen has one file per concern:

- `XUiState.kt`: an immutable `data class`, with defaults that render an empty screen.
- `XViewModel.kt`: exposes exactly one `StateFlow<XUiState>` (`stateIn(viewModelScope, WhileSubscribed(5_000), …)`) and takes events as functions. It owns screen-only state in private `MutableStateFlow`s combined with repository flows. Text drafts (the composer, the personality) live in `SavedStateHandle.getMutableStateFlow` so they survive process death (the composer draft comes back only for a chat that still exists after the restart, or a new chat not yet created); open sheets, editors and a picked image do not. It has a `Factory` in its companion.
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
(the personality was saved) is a field in the UI state; the Route acts on it in a
`LaunchedEffect` once its entry is resumed (`withResumed`), so the navigation is not dropped, and only
then tells the ViewModel it was handled.

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
BellaClaw chat once, so Back from it lands on Home. New chat pushes the chat destination with a new chat
id (`newChatId()`) at once, with no request. Both graphs hold the login link confirmation
(`LinkDestination`, no arguments) and push it whenever a link starts waiting (`PendingLinkEffect`);
every way out of it (Cancel, Done, Back) dismisses the link, and the screen closes once its link no longer waits.
A tapped notification names its chat in the intent (`MainActivity.EXTRA_CHAT_ID`); `MainActivity` hands it to
`AppViewModel` (only while signed in, and not for an intent relaunched from Recents), whose
`chatToOpen` `BellaClawNavHost` opens above Home, replacing what was there (a chat already on top
stays, with its draft), and then reports opened.

Both `NavHost`s take the same transitions (`NavTransitions.kt`): forward, a 300 ms slide from the end;
back, the reverse slide. The back gesture seeks the predictive pair
(`predictivePopEnterTransition`/`predictivePopExitTransition`, which otherwise default to Navigation's
own fade and scale), set to the same slide.
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
  body with a `Content-Length`: JSON, or an image upload's bytes (`postBytesSignedIn`). `post` goes to a server named by the caller (sign-in, link check);
  `getSignedIn`, `getBytesSignedIn` (an image), `postSignedIn`, `postBytesSignedIn` and `putSignedIn` go to the session's server with
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
- `streamSignedIn` reads a server-sent event stream (`GET /api/stream`) on the same client, handing
  each event's type and data to its caller on an IO thread until the stream ends; cancelling the
  caller cancels the call. The 70 s read timeout also ends a stream whose 25 s keep-alive stopped.
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
  `AppPush` (`conversationKey`, `kind`, `messageId`, `text`; `kind` as the
  list names it) and queues it on `pushes` (one collector; kept until collected). A message that arrives
  signed out, or does not decrypt or parse, is dropped, and one still waiting when its session is no
  longer the session is dropped when its turn comes. A push counts as handled once its collector
  returns; `PushService` waits for that (`awaitHandled`) for up to 9 s, inside the time FCM gives a
  data message, so the fetch runs while FCM keeps the process.
- Notifications: `PushNotifications`, created with the `AppContainer` (so FCM starting the process
  starts it), collects `pushes` in the application scope. Each push shows at once as its
  conversation's notification (`Notifier.show`, the one per conversation key replaced) with what
  `ChatRepository.notificationOf` knows: the chat it opens, from the push's `kind` (the BellaClaw chat
  for `bella`, else the plain chat whose id is the conversation key), a plain chat's title, null while
  the list has not named it, and the push's text. `ChatRepository.catchUp` then reads the list and
  syncs that conversation's history, for up to 8 s so a stalled read never holds the next push back
  (a cut catch-up is left unfinished), and the notification is shown again, without alerting, if the
  title or the text changed: the title once known, the text of row `messageId` once history has it. A conversation whose chat is
  open on screen while in the foreground gets none, and loses its notification when its chat opens;
  any change of session clears all of them, and a show for a session that is no longer the session is
  skipped. `AndroidNotifier` posts them, tagged with the conversation key, on two channels the person
  switches in Android's settings: `bellaclaw` (the BellaClaw chat) and `chats` (plain chats), chosen by
  the push's `kind`. The title is the BellaClaw chat's name, or the plain chat's title, "New chat"
  while it has none or is not known; the text shows expanded. Tapping one opens its chat. Without the `POST_NOTIFICATIONS`
  permission nothing is shown. Settings →
  Notifications opens Android's notification settings for the app.
- The permission is asked once the signed-in graph shows (`AskNotificationPermission`, once per
  activity), only while not granted and Android reports no rationale: never asked, so after a refusal
  nothing asks again.
- Off without Firebase: the Google services plugin is applied only when `app/google-services.json`
  exists (gitignored, never committed). Without it, or without Google Play services, `FirebasePushTokens`
  gives no token and push is simply off.
- Never log a push payload or its text, a key, the auth secret or an FCM token; `DeviceBody` is a plain class.
- Test seams: `DeviceKeys.agree` (the ECDH step, so JVM tests use a software key), `PushTokens` and
  `Notifier`.

## Settings

- `SettingsSnapshot` holds the account's `models` and `personality` and the plain chats' model list
  (`chatModels`) as `Loadable` (loading until the first answer, then loaded or failed with an
  `AccountError`) and the `theme`. Settings screens show
  a loading state, then the settings, or the error with Retry (`LoadingContent`, `LoadFailedContent`).
  Previews build small values inline.
- `SettingsRepository` watches the session from its construction: when one starts (a new token) it
  drops what it held and loads `GET /api/model`, `GET /api/personality` and `GET /api/models`; when it ends (sign-out,
  a `401`) it drops them back to loading. The theme stays. An answer is applied only while the
  session that asked is still current. The Models screen reloads the models when it opens
  (`reloadModels`, in the application scope); no reload starts while a model change is verified, and
  a reload's answer is dropped when a change or another reload started after it did.
- `ModelSettings` is the server's model state: the active provider of `providers` (ids), a
  `RoleModel` per role (model id, effort or null for the model's default, service tier) and the active provider's
  `AiModel`s with the efforts each supports and whether it takes a service tier. The server's purposes,
  efforts and tiers map in `SettingsMapping.kt`.
- `chatModels`, the chat's model picker list (`GET /api/models`), is every provider a plain chat may use
  (`ChatProvider`): whether it can be used now and its `AiModel`s. It is
  read when a session starts and each time the picker opens (`reloadChatModels`, in the application
  scope). A held list stays while it is read again and when that read fails, so the picker shows it at
  once. A read's answer is dropped when another read of the list started after it did. Opening a plain chat, or its picker, also reads again the
  account's models or the list when their last read failed.
- A model change (provider, a role's model, effort and service tier, a role's reset) runs in the application
  scope, so leaving the screen does not drop it. While it is verified, `isChangingModels` is set and
  no second change starts; the answer replaces the models, a refusal leaves them and sets
  `modelsChangeError` to the server's text, which stays through reloads until the next change
  starts. A role change sends only what differs from the server's current selection; an effort the
  newly picked model lacks falls back to the model's default. The sheet offers the service tier
  (Default, Flex, Priority) only for a model that takes one, and only then is a changed tier sent. New models that lack the open role
  sheet's model, or its effort, close the sheet; the sheet labels any effort, so no value the
  catalog lacks breaks it.
- The personality saves with `PUT /api/personality` (all three fields) from the screen's scope; a
  refusal keeps the draft and shows the server's text. The fields take no input while the save runs
  and, after a success, until the screen has closed. The theme is written to `files/theme.json`
  (through `theme.json.tmp`) and read once when the store is created, so the first frame has it.

## Conversations and the live stream

`ChatRepository` is the gateway's app API client for conversations (`docs/gateway.md`, "The App").
Everything it holds is one immutable `ChatState` in a `MutableStateFlow`, changed only with `update`.

- **Session.** The state belongs to one session: on every change of `AccountRepository.session`
  (sign-in, sign-out, a `401`) it is replaced by an empty one with a new `generation`, so every
  conversation, row, pending send, reply and typing mark is gone. A network answer applies only to
  the generation that asked for it. History lives in memory; each start fetches it.
- **The stream** (`ChatStream.runStream`, which `ChatRepository` starts) is open while signed in and in the foreground (`AppContainer.foreground`, which
  `MainActivity` sets on start and clears on a stop that is not a configuration change). A dropped
  stream reconnects after 1 s, doubling to 30 s, back to 1 s once a stream delivered an event. It
  needs nothing else to catch up: every stream opens with `check`. A failed read of the list, or of
  an open chat's history, is tried again with the same delays in the stream's scope (`ChatSync.live`),
  so the retrying ends with a success, a session change or the background; one retry loop at most per
  list or conversation, so a `check` or `changed` meanwhile reads once but starts no second loop. `isStreamOpen` is true from that
  first event until the stream ends; typing marks and steps stay until the next `check`.
- **Events.** `check`: typing off, read the list. `changed`: read the list. `typing`: mark or unmark the
  conversation. `deleted`: drop the plain chat; an open screen sees `isMissing`. `reply`: an assistant
  message kept in memory only (`ChatState.replies`), shown once in its conversation for as long as the
  session lasts. `step`: a step of the reply in progress (`ChatState.steps`, by step id: `started`, then
  `completed` or `failed`), kept until that conversation's typing ends or a `check`.
- **Activity steps.** A reply's activity is one card, a `ChatRow.Activity` list item. While a reply is in
  progress it is the first row (`isLive`): the typing dots, then its steps appended as they come. Typing
  ends before the reply lands, so the ViewModel keeps the ended turn's card until another message is the
  newest, 10 s at most; typing again with no message since (a reconnect's replay) resumes it. A history row's `steps` come with its `Message` and show as a card above the reply,
  folded to "4 steps · 14s" (from the first step's start to the last end), which a tap unfolds; open or
  closed is the list's own state. A turn seen live keys its card from typing on, and the reply whose
  first step started then keeps that key, so the live card folds in place; any other reply's card is
  keyed by its message. Items come, go and move with `animateItem`. `activityRows` shapes both: a
  "Thought for Ns" row before a step that began a second or more after every earlier one ended, and
  "Thinking…" last while typing with no step running.
- **The list and revisions.** Reading the list (`ChatSync.refreshList`) replaces it, marks it loaded,
  drops what belongs to conversations no longer in it, and syncs each loaded history whose revision is
  below the list's, and the history of each open chat that has none (its first read failed, or the
  chat was not known when its screen opened). A sync (`ChatSync.syncHistory`) fetches the rows `after`
  the newest one held, page by page, recording the new revision only after the last page; or, when
  nothing is held, the held revision is below `rewriteRevision`, or an `after` page names a
  `rewriteRevision` above the held revision, the newest 50 anew. It repeats
  while the history is still below the list's revision and the last fetch moved it on, so a change
  during the first read is caught up. Reads of the list run one at a time, and so do the syncs of one
  conversation. Older pages load with `before` when the reader reaches the oldest row (`loadOlder`).
- **Chat ids.** The Bella conversation is always `BELLACLAW_CHAT_ID` in the app and always listed, so
  its screen never waits; a plain chat's id is its conversation key, and its screen waits for the list
  before it can be missing. A new chat (`new:` and a UUID, `isNewChatId`) is an untitled plain
  chat with no conversation: its screen shows at once and nothing is sent until its first message. Its
  sends wait under its own id (`keyOf` answers it; list reads keep them); the first one's post creates the
  chat first (`POST /api/conversations`), moves its sends and model to the new key and records the key in
  `ChatState.createdChats`, so `chat(newId)` then answers the created chat. `ChatViewModel` keeps the
  screen's id in its `SavedStateHandle` and moves it to that chat's id, so the screen survives rotation and
  process death as that chat. A failed create marks the send `FAILED`, and a retry creates, then sends.
  Left without a message, a new chat creates nothing and its pick is forgotten. Its sends keep their lock
  (`sendLocks`) under the created key, so they go out in order across the id change. A created chat is kept whether or not the list has
  loaded (that is its own fact, `ChatState.isListLoaded`). The server answers the
  account's empty plain chat when it has one, so a key the list holds already is not added again. Home
  lists a plain chat only once it has a message (`latestMessages`: the list's newest row, else the
  newest this phone holds, such as a send in progress). `chat(chatId)` reads the list
  and that fact from one snapshot of `ChatState`, so a restored screen never sees the list loaded
  without its chat and reports it missing. A plain chat's icon is derived
  from its key.
- **History is open.** Collecting `messages(chatId)` means the chat's screen shows: it syncs the
  history if the chat is known (else the next list read does), and marks its newest
  stored row seen in `ChatStore`. A
  conversation is unread while its newest row (from the list) is newer than the one seen.
- **Sends** (`ChatSends`). Send is disabled until the chat's conversation is known (a new chat's is its own id) and, in a plain chat, its model; the composer's draft is
  cleared only once the message is in the repository. A send shows at once as a `PENDING` message
  with a fresh `clientMessageId`, posted in the application scope. It is pending only until the post
  is answered: accepted, it shows as a sent (`STORED`) message among the rows by time, and history's
  row with that id replaces it. One history never gets (a confidential command such as `!ai-auth`,
  whose reply comes as a `reply` event) stays in memory like a reply. A refused or failed post marks it `FAILED` (with the server's text for a
  `400`), and a retry posts the same id, text and model again. A plain chat's send names its model by ids: the one picked
  (`ChatStore`), else the model used last on this phone unless the loaded list refuses it, else the account's provider and Main model at
  Main's effort, where the model's default effort becomes MEDIUM if the model lists it, else the first
  effort it lists (a send never says `default`). A send stores its model as the chat's pick and as the
  model used last, so a chat keeps the model it started with. While none of these is known (no pick,
  none used last, the account's models loading or failed) a plain chat has no model and Send waits.
  The Bella conversation's send names none.
- **The model picker** opens on the chat's model, if it has one, and shows `chatModels`: loading, or
  the error with Retry, until a list is held. Its selection is always made valid for the list
  (`pickerSelection`): a usable provider (the chat's, else the first usable), a model it lists (the
  chat's, else its first), an effort the model supports (the chat's, else MEDIUM if listed, else the
  first). With no usable model there is no selection and Done only closes. So a pick the list
  no longer allows stays on the chat until Done stores another, and picking another model keeps the
  effort when it can. It lists only the providers usable now, one at a time behind a provider select
  that opens on the selection's provider; choosing a provider there picks nothing.
- **Images.** The composer's attach button opens Android's photo picker (images only, no permission).
  A picked image is checked on the phone (`ChatImages.check`: JPEG, PNG, WebP or GIF, 5 MB at most, by
  the picker's type and size; a file whose size is not reported is read up to one byte past 5 MB to tell);
  a refused one is not attached and the composer says why. While a pick is checked the composer shows
  it with Remove and Send is off; a newer pick or a removal cancels the check, so its result never
  lands. One image per message, with or without text. A conversation's sends go out one at a time, in
  the order they were sent (`sendLocks`), so a text sent after a photo arrives after it. Its send shows at once with the picked file (`MessageImage.localUri`),
  uploads it (`POST …/media`, the bytes as the body, read up to one byte past 5 MB), then posts the
  upload's answer in `images`, unless the session the send started in has ended (its `generation`
  changed), when the send is dropped; a failed upload, or a file that can no longer be read or has
  grown past 5 MB, marks the send `FAILED` (the server's text for a `400`, `413` or `415`), and a retry
  uploads only what did not upload yet. A message's image with a `mediaId` comes from `imageFile`:
  the cache, else a download (`GET …/media/:mediaId`); one the server no longer keeps (`410`) is not
  asked for again in the session and shows the placeholder, and so does one without a `mediaId`; a
  network failure shows it too, until the image's row shows again. An upload's bytes go into the cache
  under the answer's id, so the history row that replaces the send needs no download.
- **Showing images.** The composer's thumbnail of a picked image is decoded by a `ThumbnailLoader`, and a
  message's image by a `MessageImageLoader`; the chat Route builds both: the thumbnail and a send's
  picked file through the `ContentResolver`, a history image from the file `ChatViewModel.imageFile`
  returns. Both decode off the main
  thread with `ImageDecoder`, the longer side at most the size shown: 240 dp in a bubble (keeping the
  picture's proportions; a 180 dp placeholder while it loads), the screen in the full-screen
  `ImageViewer` (`ChatUiState.viewedImage`; a tap on the bubble's image opens it, except on a failed
  send, where the tap retries like the rest of the bubble; Back closes it). `ImageThumbnail` and `BubbleImage` show a
  result only for their current image, the plain placeholder until then.
- **Image cache** (`ImageCache`, `cache/images`: Android may clear it, and it is not backed up): one
  folder per account, named by a hash of its server and username, each image by a hash of its
  conversation key and media id, so no name holds account data. On every session change only the new
  session's account folder stays (none when signed out); a download whose session has ended is not kept.
- **Kept on the phone** (`files/chats.json`, `ChatStore`): per conversation key (a new chat's id until it is
  created, then its key; a new chat's screen closed for good without a send forgets its id), the picked model and the newest row id seen; and the model a plain chat was last set to or sent with.
- **After a push** (`catchUp`), in the background too: the list is read and the pushed conversation's
  history synced, as on a `changed`, so a history read this way stays in memory and is kept in step
  like any loaded one. A failed read is retried only while the stream is open. `openConversations` names the
  conversation keys of the chats on screen.

## Lists

`ListsRepository` holds the account's to-do lists (`GET /api/lists`) in memory for the session, dropped
when it changes. The live stream's `check` and `lists` events have it read them again (`ChatRepository`
takes its `refresh` as `onListsChanged`, which `ChatStream` calls). Reads and changes go one request at
a time, in the application scope, so changes reach the server in the order they were made. A change
(`ListChange`, sent as one operation of `POST /api/lists/changes`) shows at once on top of the lists
read, as the list's last change; the answer replaces the lists. A refused or failed change is dropped,
sets `error` (the lists screen shows it once) and the lists are read again.

- **What shows** (`lists`): not ended (`endsAt`), and not swiped away; a finished list without an end
  shows for an hour after its last change (`TodoList.disappearsAt`). A swiped finished list is hidden
  through `ChatStore` until its last change moves past the one it had. The lists are shown at the time
  a minute ticker gives (`now`, which tests set), so a list leaves on time while the screen is open.
  Ordered by end, the nearest first, lists without an end last, then oldest first.
- **The pill** (`ListPill`), BellaClaw's chat only, under its bar: the first list, its progress ring,
  end and count, "+N" for the others; green (`ExtraColors.doneContainer`) once every item is ticked,
  and only then swipeable. A tap opens the lists screen (`ListsDestination`) on that list.
- **The lists screen** (`ui.lists`): the picked list, else the first, and a chip per list when there are
  more; ticking, editing an item in place (a tap; Done or leaving the field saves a changed, non-blank
  text), adding (`Add…`), a swipe to delete an item, a drag handle to reorder (`ReorderState`: the
  move is sent on release), and the menu's rename and delete (with a confirmation). Once the lists are
  read and none is left to show, the screen closes.
- **The finished card.** History's row with `listFinished` (written by the server the first time a list's
  last open item is ticked) is a `Message` with `finishedList`, drawn as an outlined card with the
  app's own strings.

## Wiring

`BellaClawApplication` creates one `AppContainer` on first use, which creates the `SessionStore`,
the `ApiClient` and each repository once. It also owns
one application-lifetime `CoroutineScope` and passes it to repositories whose work must outlive a
screen (`ChatRepository`: the stream, list and history reads, sends; `ListsRepository`: list reads and changes; `SettingsRepository`: the session
watch and model changes; `PushNotifications`: the pushes, on an `AndroidNotifier`). ViewModel
factories read it through `CreationExtras.appContainer()`. No DI framework. Repositories are concrete
classes; add an interface only when a second implementation exists.

## Tests

JVM unit tests in `app/src/test` for every ViewModel: construct it with real repositories, collect
its state (`collectIn`), send events, assert the exposed state. Chat tests run the real
`ChatRepository` against `FakeGateway` (`TestServer.gateway()`): in-memory conversations behind the
conversation and media routes, and a stream that opens with `check` and carries what the test pushes;
the photo picker's files come from `TestServer.pickedImages` (`FakePickedImages`). `FakeGateway` also answers the list routes with its `lists` JSON and records each change (`listChanges`); `TestServer.listsRepository` shows the lists at a time the test sets. A test
waits for a request off the test thread (`withContext(Dispatchers.IO)`), so the repository's work in
the test scope keeps running. Account tests use `TestServer`: a
`MockWebServer` on 127.0.0.1 (not `localhost`, which OkHttp tries as `::1` first) plus the real `SessionStore`, `ApiClient` and `AccountRepository` on a session
file in a temporary folder; a network answer reaches the ViewModel on OkHttp's thread, so after any event that follows one
they wait with `uiState.first { … }` for the state the outcome names (an error, a step), not for a
loading flag to clear, read `uiState.value` only before the first request, and before an event the
ViewModel allows only in some state (submitting a form) wait for that state too. To see a state that lasts only while a request is in flight (loading), take `TestServer.hold()` (or pass `until` to `route` for a routed answer) before queuing the answer, wait for that state, then complete the hold; no real delays. `MainDispatcherRule` replaces
`Dispatchers.Main`; repositories that take a scope get the test's `backgroundScope`, and a fixed
`Clock` where dates matter.

Push tests run the whole decryption with a software P-256 key (`DeviceKeys.agree`) against the RFC 8291
Appendix A vector and messages encrypted as the server does, and replace `PushTokens` with a fake.
Notification tests deliver such messages to the real `PushRepository`, `ChatRepository` and
`PushNotifications` on `FakeGateway`, wait with `awaitHandled`, and read what a fake `Notifier` shows. The
catch-up's 8 s bound runs on `Dispatchers.Default`, so it counts real time there too.

`TestServer.settingsRepository` adds the real `SettingsRepository`, with a `ThemeStore` that writes in
place and answers for the three settings reads; `TestServer.chatRepository` reads the models from one
unless the test passes its own. `route` answers one method and path every time, ahead of the queue
and of `FakeGateway`, so
concurrent requests get the right body whatever their order; `takeRequest(method, path)` skips the
others. A repository's work in `backgroundScope` runs only while the test suspends, so a test waits
with `first { … }` before a blocking `takeRequest`.

## Extension points

Later chunks change repository internals, not their public `Flow`/`suspend` surface, so ViewModels
stay as they are:

- Storage (cached history): a local store in `data.local` behind the same repositories.
