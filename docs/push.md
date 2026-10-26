# push

the push module, end to end: what the fleet hands it, how it decides, how
a notification reaches a lock screen, and what the service worker does
with it. the ux law is `design.md` (attention); the shape is
`architecture.md` (push and presence); presence is decision 23.

## the pieces

| piece | where | owns |
|---|---|---|
| push task | `server/src/push/mod.rs` | subscribed devices (mirrored from `boxbox.db`), presence, "done" notices waiting out their delay, each device's rate bucket and hold, recently sent ids |
| `decide()` | `server/src/push/decide.rs` | the pure decision, table-tested as the push matrix |
| presence | `server/src/push/presence.rs` | per device: looking or not, the thread on stage, the windows in view |
| rate and dedupe | `server/src/push/limit.rs` | a bucket of 4 per device refilling one every 15 s; a hold keeping the newest per thread; the (device, notice id) pairs sent in the last 30 minutes |
| payload | `server/src/push/payload.rs`, `app/src/push/payload.ts` | the json a device receives, and the rules both sides apply to it |
| delivery | `server/src/push/deliver.rs` | rfc 8291 encryption, rfc 8292 signing, the post, retries |
| vapid | `server/src/push/vapid.rs` | the server's p-256 key, minted once into `push_vapid` in `boxbox.db` |
| subscriptions | `server/src/push/devices.rs` | `push_devices`: one row per device, the endpoint unique |
| routes | `server/src/http/push.rs` | `GET /api/push`, `POST /api/push/subscribe`, `/unsubscribe`, `/test`, `POST /api/presence` |
| service worker | `app/src/push/sw.ts`, served as `/sw.js` | push and notificationclick, with the app closed |
| the app's side | `app/src/push/` | device id, subscribing, presence reports, deep links, the notifications row |

## what m4 feeds it

the fleet calls `Push::notify(Notice)` for every candidate event and
`Push::continued(thread)` when an agent carries on. a `Notice` is:

- `id`: stable per event (`ask:<ask id>`, `done:<message id>`, `fault:<seq>`),
  so the same event never reaches a device twice;
- `about`: `Ask { id, kind: question | permission }`, `Done`, `Fault` or
  `Ready`;
- `thread` (`host:session`), `title` and `body`, written in the voice
  ("ledger wants you", "118 passed. all four new tests...");
- `origin`: `armed` (a person started the turn), `own_action`, `subagent`,
  `replayed`, the facts only the fleet knows;
- `badge`: the icon's number after this notice, when the fleet knows it:
  the threads with an open need. a job notice counts only when the
  person's home prefs say job notices are needs (`jobsAsNeeds`, off by
  default, decision 95); an auto-clear serves a thread's done and job needs,
  so it leaves the badge (decision 93).

### how the fleet feeds it (m4)

the fleet model (`server/src/fleet/model.rs`, with `needs.rs`) turns
the daemon's events into needs and hands push one notice per candidate:

| event | notice | origin |
|---|---|---|
| a permission or question asked | `ask:<host>:<id>`, `about: Ask` | fresh; `replayed` when a host read after a boxbox restart finds an ask it had raised |
| a root session's turn ends plainly idle | `done:<key>:<reply id>`, `about: Done` | `armed` when a boxbox send (`POST .../prompt`, with its `clientID`) started it |
| a subagent's turn ends | the same id | `subagent` |
| `session.error`, or a turn cut off | `fault:<key>:<seq or reply id>`, `about: Fault` | `own_action` within 15 s of a stop sent through boxbox (`POST .../abort`) |
| a checkout asks for review | `review:<key>:<checkout>:<seq>`, `about: Ready` (the event's seq, or `t<ms>` when it had none: each request is its own id, so an agent sent back with notes that asks again pushes again, and a replayed event pushes nothing) | fresh |

a new turn in a thread calls `continued`, which drops a "done" still
waiting. when a person serves a need that was pushed (from any device),
the fleet calls `served` and push writes `push.acted` with the time from
the push to the answer. a turn that ends while a looking device has the
thread on stage raises no need but still reaches `decide`, so its
`push.decided` row says `watched`. push publishes who is looking to the
fleet (a watch channel), which is how a thread on stage is seen.

## the decision

`decide(notice, stage, watched, devices)`, in order: replayed, subagent,
own action are never pushed; a "done" nobody armed is `not-armed`; a
watched thread is `watched`; a fresh "done" waits 10 s and is decided
again (dropped as `watched` the moment a device looks at the thread, as
`continued` if the agent carries on or a newer "done" replaces it); then
every device whose kinds include the notice's kind gets it, else
`no-subscriptions` or `kind-off`. every decision writes one `push.decided`
row; a notice every device already had is `duplicate`.

**watched** (decision 23). a device is looking when its last presence
report said visible and focused and is under 90 s old. a thread is
watched when a looking device has it on stage or its window in view. the
app reports on every change and every 30 s while looking, and sends a
last "not looking" as a beacon on `pagehide`. the same watch decides
whether an auto-clear is away (no device looking at the moment of the
sweep, so it joins the away summary) or offered as an undo to the device
that is looking (decision 94).

## delivery

one post per device through its push service. the body is encrypted
aes128gcm (`web-push-native`), the `Authorization` is `vapid t=<es256
jwt>, k=<public key>` signed here (12 h lifetime, audience the
endpoint's origin, subject `[push] contact`). headers: `TTL` 12 h,
`Urgency: high` for asks and faults (`normal` otherwise), and `Topic` a
hash of the thread tag, so a push service holding messages for an
offline phone keeps only the newest per thread.

| answer | meaning | what happens |
|---|---|---|
| 201 | the push service took it | `push.sent ok=1` |
| 404, 410 | the subscription is gone | the device is forgotten, `ok=0` |
| 429, 5xx, network | worth another try | up to 3 posts, 2 s and 10 s apart (or `Retry-After` up to 60 s) |
| other | refused | `ok=0`, the status and the body's head logged |

endpoints are taken only at known push services (fcm, apple, mozilla,
wns) over https, since the url comes from a browser and the server posts
to it.

## the payload

```json
{
  "v": 1, "id": "ask:que_1", "kind": "ask", "need": "question",
  "tag": "thread:desk:ses_1", "thread": "desk:ses_1", "ask": "que_1",
  "title": "ledger wants you", "body": "which greeting?",
  "url": "/?thread=desk:ses_1&ask=que_1&push=ask:que_1",
  "actions": [
    {"action": "answer", "title": "answer", "url": "/?thread=desk:ses_1&ask=que_1&push=ask:que_1"},
    {"action": "open", "title": "open", "url": "/?thread=desk:ses_1&push=ask:que_1"}
  ],
  "device": "<device id>", "deviceClass": "iphone", "sentAt": 1790797589988, "badge": 2
}
```

title at most 80 characters, body 240, the whole under 3 kb (a push's
encrypted body must stay under 4096 bytes). only asks carry "answer";
the other kinds carry "open". every link is a path in the app, and the
worker refuses a payload whose links are not.

## the service worker

- **push.** shows a notification for every push, tagged by thread (a
  thread's newer news replaces its banner, `renotify` so it is noticed),
  sets the badge when the payload carries one, and posts `push.delivered`
  (with `open` 1 or 0 and `ms` against the server's `sentAt`). a payload
  it cannot read still shows a plain "something needs you" banner.
- **notificationclick.** closes the banner, then focuses an open boxbox
  window and posts it `{type: "boxbox.open", url}`, or opens the app at
  the link; posts `push.tapped` with `action` answer, open or banner.
- the app takes the link at launch or from the message into
  `state.focus` and clears the query with `replaceState`; the thread ui
  opens it.
- while a thread is looked at, the app closes that thread's banners.
- **precache.** the build hands the worker every file it wrote
  (`app/vite.config.ts`: `BOXBOX_PRECACHE`, `index.html` as `/` first, then the
  hashed assets and the public files, never `sw.js` itself, a precompressed
  copy, the board's chunk or the icons under `icons/`: the browser fetches
  those for the manifest and the home screen icon when boxbox is installed,
  so a launch does not carry their 167 kb) and a hash of their bytes as
  its build id (`BOXBOX_BUILD`, so a new build is a new `sw.js`). install
  caches them all in `boxbox-ui-<build>`, and a file that fails to arrive
  fails the install rather than leave a half-filled cache. a navigation is
  answered with that build's `/` and a precached path with its cached
  copy, so a cold launch paints with no network and never mixes two
  builds; `/api/`, other origins and anything not precached go to the
  network untouched, and a cache the browser evicted falls back to the
  network. activate deletes every older `boxbox-ui-` cache. in dev nothing
  is precached and fetch is left alone.
- it installs and waits: a new worker takes over at the next cold launch,
  never under an open window, and home's bar says "update ready. it
  applies the next time boxbox opens." meanwhile. the one exception is a
  protocol break: the page asks the waiting build to take over
  (`boxbox.take-over`, `app/src/shell/worker.ts`) before its reload.

## the subscription on each launch

the app keeps a copy of what the server last held for this device
(`app/src/push/saved.ts`, one localStorage entry under `boxbox.push.saved`:
the device, the server's key, the subscription's endpoint and keys, the
device list as the server listed it, the kinds, and when it was checked).
with permission granted, a launch reads the browser's subscription (no
network) and asks the server (`GET /api/push`) only when that subscription
is not the one the copy names or the check is a day old or more. it posts
(`POST /api/push/subscribe`) only when the server's copy differs from the
saved one: a new subscription, a new key, or a device list that changed.
a turn on, a new set of kinds, and a settings save always post. a check the
server does not answer keeps the old copy, so the next launch asks again.
permission not granted forgets the copy, so granting it again posts at once.
a launch that holds its copy costs no request at all.

## ios, installed to the home screen

what the platform allows (`design.md`, platform truth), and how boxbox
holds to it:

- **web push only in a home-screen app** (ios 16.4+). in a safari tab
  `PushManager` does not exist; the notifications row says "add boxbox to
  your home screen, then open it from there to get notifications."
- **permission only from a tap.** `Notification.requestPermission()` runs
  inside the "turn on notifications" click, never at boot. at boot the
  app only re-subscribes when permission was granted before.
- **every push must show a notification.** safari revokes a subscription
  whose pushes show nothing, so the worker always shows one, even for a
  payload it cannot read, and the server never sends silent or "tidy"
  pushes.
- **no action buttons.** ios shows the banner and a tap; the tap reports
  no action, so the banner's own link is the ask's "answer" link: tapping
  an ask opens the thread with the ask in front.
- **a delivered banner cannot be removed remotely.** one banner per
  thread tag, replaced by newer news; banners for a thread being read are
  closed by the app when it next looks.
- **the badge** is set from the worker (`setAppBadge`) when the payload
  carries one.
- **apple's push service wants a real contact.** set `[push] contact` to
  a `mailto:` or `https:` address (`boxbox.example.toml`).
- device checks still owed (`verification.md`: only a real device
  answers): delivery to the installed pwa on the iphone and ipad, the tap
  deep link, the badge, tag replacement.

## verification

- unit: `cargo test` (the push matrix in `decide.rs`, presence, rate,
  dedupe, payload, vapid signature verified against its public key, the
  store, the actor end to end on a paused clock); `bun test app/src/push`
  (payload parsing, click targets, deep links).
- real loop: `just push-harness [--headed] [--kind ask] [--await-tap 90]`
  against `just cmx2 --port <n> --boxbox-port <m>` and the release binary
  on the bench config. it launches google chrome on a throwaway profile,
  grants notifications over devtools, signs in and turns notifications on
  through agent-browser by accessible name, closes every boxbox page,
  sends a test push through fcm, prints what the worker received and
  showed, and the push.decided, push.sent and push.delivered rows.
  chrome for testing cannot subscribe (no push service keys), headless
  chrome subscribes but never receives, so the delivery run is headed.
