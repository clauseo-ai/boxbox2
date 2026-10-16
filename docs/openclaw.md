# openclaw

the normative spec for boxbox's **openclaw source**: how the boxbox server
connects to an openclaw gateway as an operator client, mirrors its agents,
threads, transcripts, approvals and questions into the fleet, sends on the
person's behalf, and fetches and sends media. it also specifies the dev
gateway (`just openclaw`) that the integration and chaos tests run against.

boxbox targets **openclaw v2026.10.1, commit
`e178c39e9aae3fa440735217f9aef9574f286677`, gateway protocol 4**. every
openclaw fact below cites that tree as `path:line`; "doc" marks a citation
into the tree's own `docs/`. where the docs and the code disagree, this spec
follows the code and says so. the seam this source plugs into (the neutral
wire, the agent and thread keys, the media store and route) is
`docs/agents.md`; names in `code` below such as `ask`, `part`, `origin` and
the capability keys are that document's. the words "must", "never" and
"always" are the contract: a change that breaks one changes this file first.

an example setup used throughout: one boxbox server on vm-a watching cmx2 on
two machines and **an openclaw gateway on vm-b** that hosts two agents,
`main` (an assistant the person talks to every day, also over whatsapp) and
`helper`.

## 1. what boxbox uses and why

boxbox talks to openclaw the way openclaw's own control ui and phone apps
do: one websocket to the gateway as a role `operator` client with an ed25519
device identity, paired once. the alternatives were compared and rejected: a
channel plugin runs inside the gateway, moves in lockstep with core and sees
only its own conversations; the openai-compatible http endpoints have no
session list, history, approvals or abort; `openclaw acp` drops runs it did
not start, cannot switch models and flattens history; `openclaw mcp serve`
sees only routed channel conversations. the operator websocket is the only
path that sees every session (whatsapp, cron, heartbeat, threads boxbox
started), with live text, approvals, questions, model and thinking control,
and a gap-free catch-up primitive (`chat.history`'s `deltaCursor`, section
5). it is the path openclaw documents for external apps, with a published
schema (section 2).

## 2. pin and contract

### 2.1 the pin

`openclaw.pin` at the repo root holds four `key = value` lines, read by
`scripts/openclaw-pinned.ts` and by the server's build script:

```
commit = e178c39e9aae3fa440735217f9aef9574f286677
version = 2026.10.1
protocol = 4
schema = sha512-3zAGtYPcZZIe3Rrbn8fyTpJnmvH7R+zUQ0CutGuRd5Uo01rXEgCp5QqMvPGUDMT4oiwwNoATsOycjYmLDWBa2g==
```

- `commit` is the tree the dev gateway builds (section 11). `version` is the
  tree's `package.json:3`. `protocol` is `PROTOCOL_VERSION`
  (`packages/gateway-protocol/src/version.ts:2`; clients must send
  `minProtocol = maxProtocol = 4`, `MIN_CLIENT_PROTOCOL_VERSION` at `:4`).
- `schema` is the npm integrity of `@openclaw/gateway-protocol@2026.10.1`,
  the tarball the vendored schema comes from (2.2).
- moving the pin is a deliberate step, like `cmx2.pin` (AGENTS.md, cmx2):
  edit `openclaw.pin`, run `just vendor`, rebuild, run `just check`, run
  `just openclaw --fresh` and the openclaw integration and chaos suites
  (section 12), and record the move in `CHANGELOG.md` with what changed in
  the contract.

### 2.2 the vendored schema

`vendor/openclaw/protocol.schema.json` is copied byte for byte from the
**published** `@openclaw/gateway-protocol@<version>` npm tarball, not from
the tree. why:

- the file is not in the repository at any commit. it is generated at
  `prepack` (`packages/gateway-protocol/package.json:93`, `scripts/protocol-gen.ts:14`)
  and the package readme says so: "generated during `prepack` and is not
  committed to the repository" (`packages/gateway-protocol/README.md:175-182`).
  generating it ourselves needs the whole workspace installed, which `just
  check` must not need.
- the published file is the one openclaw's release pipeline checks against
  its canonical typebox registry ("published protocol.schema.json differs
  from the canonical TypeBox registry",
  `test/e2e/qa-lab/runtime/gateway-protocol-artifacts.ts:223`), so it is
  the contract third parties are promised.
- package versions follow the release train, separately from the wire
  version (doc `docs/gateway/clients.md:31-36`), so the package version
  equals the pinned openclaw version exactly.

`just vendor` (`scripts/vendor.ts`, which also re-copies cmx2's files) runs
`npm pack @openclaw/gateway-protocol@<version>` into a temp dir under
`/tmp`, checks the tarball's sha512 against `schema` in the pin, and copies
`package/protocol.schema.json`. `vendor.ts --check` (already in `just
check`) recomputes the vendored file's sha256 and compares it with
`vendor/openclaw/protocol.schema.sha256`, written by `just vendor`; it needs
no network. at 2026.10.1 the file is 4,605,524 bytes, sha256
`b7ab8a5113021fc73344ab5fef3d84009b4d9b0dfb852287eadd031fed65cf72`, json
schema draft-07, with a discriminated frame union on `type`, 1050 named
definitions and a `methods` map of 510 core methods, each `{since, scope}`.

`just openclaw` also regenerates the schema from the exported tree
(`pnpm protocol:gen`, `package.json:1929`) once per build and fails loudly
if it differs from the vendored file, so a tarball that drifted from its
tree is caught on the first dev run.

### 2.3 rust types: typify at build time, hand-written serde where the schema is open

**choice:** the rust types for frames, params, results and event payloads
are generated at build time by **typify** from the vendored schema, in
`server/build/openclaw.rs`, beside `server/build/cmx2.rs` and following its
shape. transcript message bodies, which the schema leaves open, get
hand-written serde types in `server/src/openclaw/transcript.rs`, held to
recorded fixtures.

why:

- it is boxbox's existing rule ("types for cmx2 are generated at build time",
  `docs/architecture.md`, the backend) and its existing tool: `typify 0.8.0`
  and `schemars` are already build dependencies (`server/Cargo.toml`,
  `THIRD_PARTY.md`), so AGENTS.md (dependencies) is met with **no new crate**. typify is
  oxide computer's json schema to rust generator, maintained (a release on
  2026-10-14), apache-2.0. the pinned 0.8.0 stays; nothing here needs a
  newer one.
- the schema is draft-07, which typify reads natively; cmx2.rs already
  handles the two typify gaps that matter here (a discriminated `oneOf` it
  would emit as untagged, and one-value enums).
- generating all 1050 definitions would compile a large module of types
  boxbox never touches. the build script names its **roots** and typify
  pulls in what they reference: `ConnectParams`, `HelloOk`, `ErrorShape`,
  `RequestFrame`, `ResponseFrame`, `EventFrame`, `TickEvent`,
  `ShutdownEvent`, `Snapshot`, the params and results of every allowlisted
  method (section 4: `SessionsListParams`, `SessionsCreateParams`,
  `SessionsCreateResult`, `SessionsPatchParams`,
  `SessionsMessagesSubscribeParams`, `SessionsMessagesUnsubscribeParams`,
  `ChatSendParams`, `ChatAbortParams`, `ChatHistoryParams`,
  `ChatHistoryCursorResult`, `ChatMessageGetParams`, `ChatMessageGetResult`,
  `AgentsListParams`, `AgentsListResult`, `ApprovalGetParams`, `ApprovalGetResult`,
  `ApprovalResolveParams`, `ApprovalResolveResult`, `ApprovalSnapshot`,
  `QuestionListResult`, `QuestionGetResult`, `QuestionResolveParams`,
  `QuestionResolveResult`, `QuestionRecord`, `ArtifactsDownloadParams`,
  `ArtifactsDownloadResult`, `SessionReactionsSetParams`,
  `SessionReactionsSetResult`, `SessionReactionsListResult`,
  `ModelsListParams`, `ModelsListResult`) and of every consumed event
  (`ChatEvent`, `SessionRow`, `SessionApprovalEvent`,
  `SessionApprovalReplay`, `SessionNarrationEvent`, `SessionReactionEvent`,
  `QuestionResolvedEvent`).
- **decode is tolerant.** a string `enum` of more than one value is read
  as a plain string, since openclaw adds values (auth methods, approval
  kinds) without moving the protocol and a closed set would fail the whole
  frame; one-value sets (discriminators) stay. string and array bounds and
  `pattern` are dropped for the same reason; the drift test reads the
  bounds boxbox relies on from the schema itself.
- 928 of the 1050 definitions are closed objects
  (`additionalProperties: false`), and openclaw adds fields without bumping
  the protocol (doc `docs/gateway/protocol/rpc-bootstrap-and-events.md:133-134`).
  typify turns a closed object into `#[serde(deny_unknown_fields)]`, which
  would make an additive gateway release unreadable. the build script
  strips `additionalProperties: false` before typify runs, so inbound
  decode ignores unknown fields; outbound params are built only from the
  generated structs, so boxbox can never send a field the schema does not
  have.
- **the open parts are hand-written.** the schema leaves about 60 fields as
  `Type.Unknown()` on purpose, the transcript message bodies among them
  (`packages/gateway-protocol/README.md:163-173`): a delta's `messages` is
  `Array(Unknown)` (`packages/gateway-protocol/src/schema/logs-chat.ts:158`),
  every `chat` event's `message` is `Unknown` (`logs-chat.ts:419, 429`),
  `sessions.changed` has no schema at all, and the thinking fields on a row
  are undeclared extras (`packages/gateway-protocol/src/schema/sessions-row.ts:273`
  is `additionalProperties: true`; the fields are written at
  `src/gateway/session-utils-row.ts:534-540`). those types live in
  `transcript.rs` and `events.rs`, decoded leniently (unknown block types
  become a fallback, never an error), and are tested against fixtures
  **recorded from the dev gateway** (AGENTS.md, integration tests: fixtures only for wire
  parsing, recorded from a real gateway), committed under
  `server/tests/fixtures/openclaw/`, each named for the scenario that
  produced it.

the alternative, hand-written serde for everything plus a drift test, was
rejected: it is the exact hand-decoding `architecture.md` rules out, and the
generated route gives the drift test for free (a renamed field fails the
build, not a phone).

### 2.4 the drift test

`cargo test openclaw_contract` (in `just check`) asserts, against the
vendored schema:

- every method in the allowlist (section 4) is in `methods`, with the scope
  this spec expects for it (`operator.read`, `operator.write`,
  `operator.approvals`, `operator.questions`, or `dynamic` for
  `sessions.create` and `sessions.patch`);
- every root definition in 2.3 exists, and the fields boxbox reads or
  writes on each still exist with the same type and requiredness (a table
  in the test, one row per field: `ChatSendParams.queueMode` enum still
  holds `followup`, `ApprovalResolveParams` still has exactly `id`, `kind`,
  `decision` required, `ChatHistoryParams.maxChars` maximum still 500000,
  and so on);
- `HelloOk.policy.attachments`, `HelloOk.server.bootId` and
  `HelloOk.auth.deviceToken` exist;
- every recorded fixture decodes with no fallback blocks.

a second half runs in the integration suite against the dev gateway: the
`hello-ok` `features.methods` and `features.events` include every method and
event boxbox uses.

### 2.5 the version policy

checked on every `hello-ok`, before any other request:

the words on the agents screen are `docs/home.md`'s pairing states, the one
source for that copy; this table says which state each case is and what
the connection reports (`status`, `pinned`, `untested`, `protocol`,
`refused`, `lastError`, `docs/agents.md`).

| what the gateway says | boxbox does | the agents screen shows |
|---|---|---|
| a `connect` refusal for protocol, or `hello-ok.protocol` not 4 | **refuses**: closes, sends nothing more, keeps the agents' threads readable from what clients and the read cache hold (marked stale), retries only after the config changes or every 30 min | home.md's "refused protocol" state; `status: refused`, `refused: "protocol"`, `protocol` the gateway's number |
| protocol 4, `server.version` equal to the pin's `version` | connects normally | nothing extra |
| protocol 4, a different `server.version` | **connects and marks the connection untested**: full sync and every verb | home.md's "untested version" state; `untested: true`, `pinned: "2026.10.1"` |
| protocol 4 but a sync method missing from `features.methods` (`sessions.subscribe`, `sessions.list`, `chat.history`) | refuses, as for protocol | `status: refused`, `refused: "methods"`, `lastError` "vm-b does not offer sessions.subscribe; boxbox cannot sync it." |
| protocol 4, a verb's method missing | connects; that verb's capability goes false (section 9), so clients hide it and the route answers 422 `unsupported` | "vm-b does not offer session.reactions.set." |

at 2026.10.1 every allowlisted method is advertised: none is marked
`advertise: false` in `src/gateway/methods/core-descriptors.ts` (lines 51,
59-62, 71, 101, 155, 169, 210-213, 223, 230, 323, 326, 327, 328, 420, 421,
452, 453). `openclaw.approval.list` belongs to the optional
system-agent-approvals family (`core-descriptors.ts:71`) and may be absent
on a gateway without it; the approvals poll skips a list whose method is
not advertised (5.9).
the readme warns that `features.methods` is "conservative discovery, not a
complete enumeration" (`packages/gateway-protocol/README.md:184-191`), which
is why a missing verb only disables that verb.

**decode guard:** a frame whose required field is missing or mistyped is
dropped and counted (`openclaw.decode_failed` telemetry, labelled by event
or method), and its session goes to `needs_tail`. more than 5 in 10 minutes
on one connection turns off sends, approval and question answers for 30
minutes (the connection shows "boxbox could not read vm-b's answers;
sending is paused"), because a misread send or a malformed
`approval.resolve` has real consequences (section 7.9).

## 3. connection

### 3.1 config

one `[[openclaw]]` entry per gateway in `boxbox.toml` (mode 0600). a second
gateway on another machine is another entry.

```toml
[[openclaw]]
name = "vm-b"                          # the connection name, [a-z0-9-]{1,24}
url = "wss://vm-b.example.ts.net"      # ws:// only for loopback
token_file = "/etc/boxbox/openclaw-vm-b.token"
# device_key = "/etc/boxbox/openclaw-vm-b.key"   # optional, see 3.2
# mode = "full"                        # "watch" sends nothing that writes

[openclaw.agents.main]                 # optional, one table per gateway agentId to pin
key = "assistant"                      # pins the agent key (docs/agents.md)
name = "assistant"
palette = "coral"
```

- `token_file`: the gateway's shared token (`gateway.auth.token`), one line,
  mode 0600 or the server refuses to start ("openclaw-vm-b.token is
  readable by others; chmod 600 it"). it is read at start and on config
  reload, never logged, never sent to a client. it is used to pair and as a
  fallback (3.4).
- `mode = "watch"` makes every write verb unavailable at the allowlist
  layer (section 4), for the first days on a new gateway: sync, live text
  and needs work; `chat.send`, `chat.abort`, `sessions.create`,
  `sessions.patch`, `approval.resolve`, `question.resolve` and
  `session.reactions.set` are refused before they reach the socket.
- the agents under a connection come from the gateway (3.8), not from the
  file; the file may only rename, re-key or re-colour them.
- `boxbox doctor` checks each entry: the url parses, the token file exists
  with mode 0600, the device key (if given) is a valid key with mode 0600,
  and the last connection state.

### 3.2 the device identity

- an **ed25519** key pair per connection. the device id is the lowercase
  hex sha256 of the raw 32-byte public key
  (`src/infra/device-identity.ts:90-101`); the public key is sent as
  base64url of the raw bytes, and signatures are base64url
  (`src/infra/ed25519-signature.ts:152-170`).
- **storage:** by default the key is generated on first start and kept in
  `boxbox.db`'s `source_secrets` table (owned by `docs/agents.md`; the
  database is mode 0600, written only by the store writer), as pkcs#8 v2
  der, one row per connection. if `device_key` is set, boxbox reads the key
  from that file instead (pkcs#8 pem, mode 0600 or refuse to start, never
  written by boxbox), so an operator can provision or back it up. losing
  the key means pairing again; nothing else is lost.
- **crypto:** `aws-lc-rs`, already in the build (the version rustls
  compiles, `Cargo.lock`), taken as a direct dependency with the same
  version for `Ed25519KeyPair` generation, pkcs#8 load and signing. no new
  crate; `THIRD_PARTY.md` gains the row.

### 3.3 the handshake, exactly

1. open the websocket (tokio-tungstenite, already in the tree). the gateway
   sends `connect.challenge` first: `{nonce, ts, capabilities}`, `ts` its
   own `Date.now()` (`src/gateway/server/connection.ts:339-349`).
2. build `connect` params (`packages/gateway-protocol/src/schema/frames.ts:31-92`):
   - `minProtocol: 4, maxProtocol: 4`;
   - `client: {id: "gateway-client", mode: "backend", version: <boxbox
     version>, platform: "linux" | "darwin", instanceId: <the connection's
     stable uuid from source_secrets>, displayName: "boxbox"}`
     (ids and modes: `packages/gateway-protocol/src/client-info.ts:10-49`);
   - `role: "operator"`;
   - `scopes: ["operator.admin", "operator.approvals", "operator.questions",
     "operator.read", "operator.write"]` (sorted, the order signed);
   - `caps: ["approvals", "chat-only-assistant-text", "session-scoped-events", "tool-events"]` (3.5);
   - `auth: {deviceToken}` once paired, else `{token}` (3.4);
   - `device: {id, publicKey, signature, signedAt, nonce}`.
3. **`signedAt` is the challenge's `ts`, never boxbox's clock** (doc
   `docs/gateway/protocol/handshake.md:26-30`). the gateway rejects a
   `signedAt` more than 2 minutes from its own clock
   (`src/gateway/server/ws-connection/connect-device-proof.ts:13, 63-66`),
   so signing with the gateway's own time makes skew irrelevant. `nonce` is
   the challenge's nonce, checked exactly (`connect-device-proof.ts:68-75`).
4. the **v3 payload** is the utf-8 string
   `v3|<deviceId>|<client.id>|<client.mode>|<role>|<scopes joined by ",">|<signedAt>|<token>|<nonce>|<platform>|<deviceFamily>`
   (`packages/gateway-client/src/device-auth.ts:40-60`), where `token` is
   `auth.token ?? auth.deviceToken ?? auth.bootstrapToken ?? ""`
   (`src/gateway/server/ws-connection/handshake-auth-helpers.ts:262-269`)
   and `platform` and `deviceFamily` are trimmed and lowercased, empty when
   absent (`device-auth.ts:1-6`). the gateway verifies v3 first, then v2
   (`handshake-auth-helpers.ts:271-307`); boxbox only signs v3. the
   signature is ed25519 over those bytes.
5. send `{type: "req", id, method: "connect", params}`. the answer is a
   `res` whose payload is `hello-ok` (`frames.ts:94-175`).
6. validate `hello-ok` (2.5), then record `server.bootId`, `server.version`,
   `snapshot.uptimeMs`, `policy.{maxPayload, maxBufferedBytes,
   tickIntervalMs, attachments}`, `auth.scopes`, and the sha256 of the
   sorted `features.methods` and `features.events`. if `auth.deviceToken`
   is present, store it (3.4).
7. if `auth.scopes` lacks any requested scope, the connection is degraded.
   **without `operator.admin` every send is off**, not only some
   approvals: `suppressCommandInterpretation` is a system provenance field
   that needs admin, and a send carrying it without admin is refused
   ("system provenance fields require admin scope",
   `src/gateway/server-methods/chat-send-request.ts:147-161`). boxbox never
   drops the flag to make a send work (7.2): sends, new threads and every
   write capability that starts a turn go false, the composer is
   disabled, and the agents screen shows the card's degraded state with
   `lastError` "approve admin on the gateway: vm-b granted boxbox less than
   it asked for, so boxbox cannot send. some approvals will not show
   either." and a re-pair (3.4). without `operator.approvals` or
   `operator.questions` only those asks go dark, said the same way.

### 3.4 pairing, as the person sees it

- first connect from a new device over the tailnet: the gateway refuses
  with `PAIRING_REQUIRED` and a `requestId` in the error details
  (`packages/gateway-protocol/src/connect-error-details.ts:47, 73-78`; the
  close reason carries it as "(requestId: ...)", `:306-313`).
- the agents screen shows vm-b's card with "waiting for approval" and one
  instruction with the id filled in:
  **approve boxbox on the gateway: `openclaw devices approve <requestId>`**
  (doc `docs/gateway/pairing.md:103-108`). boxbox keeps reconnecting with
  backoff capped at 30 s, as openclaw's own headless clients do (doc
  `pairing.md:110-111`), and the card turns live on the first `hello-ok`.
- pair once with **all five scopes**: a remote client that later asks for
  more goes through the scope-upgrade policy, a fresh approval (doc
  `handshake.md:216-217`). admin is not optional: without it boxbox cannot
  send at all (3.3 step 7).
- **on loopback there is no pairing.** a `gateway-client`/`backend` client
  on a direct loopback connection with the shared token skips device
  pairing even when it signs a device identity, and receives no device
  token (`handshake-auth-helpers.ts:222-244`; doc `handshake.md:209-218`).
  boxbox on the same machine as its gateway therefore runs on the shared
  token alone and uses it as the http bearer too. over the tailnet the
  locality is remote and the pairing above applies.
- **the device token:** `hello-ok.auth.deviceToken` (`frames.ts:132`) is
  "the primary reusable credential for the same device and role" (doc
  `handshake.md:97-98`). boxbox stores it in `source_secrets`, sends it as
  `auth.deviceToken` on every reconnect, and uses it as the http bearer for
  media (section 8; device tokens are accepted on http,
  `src/gateway/http-auth-utils.ts:138-172`). a new `deviceToken` in a later
  `hello-ok` replaces the stored one.
- `AUTH_DEVICE_TOKEN_MISMATCH` (`connect-error-details.ts:24`): the stored
  token is dropped and the next connect uses `auth.token`; if that leads
  to `PAIRING_REQUIRED`, the card asks for approval again.
  `AUTH_SCOPE_MISMATCH` (`:25`) offers a re-pair the same way.
  `AUTH_RATE_LIMITED` (`:26`) is transient: retry with backoff, honouring
  `retryAfterMs`. any other auth refusal (`AUTH_TOKEN_MISMATCH` and the
  rest) stops retrying with `status: refused`, `refused: "auth"` and `lastError` "vm-b refused
  boxbox's token; check token_file" until the config changes.
- silent pairing of a local connect is the gateway's default everywhere
  unless `nodes.pairing.autoApproveLocal` is false
  (`handshake-auth-helpers.ts:82-131`); it is moot for boxbox, since a
  `gateway-client`/`backend` client on loopback skips pairing anyway
  (above). the pairing test turns it off (section 11).

### 3.5 caps

- **`approvals`** is required. approval events reach a client only with
  `operator.admin` or `operator.approvals` **and** either a known client id
  or this cap (`src/gateway/server-request-context.ts:197-221`). the known
  ids depend on the kind (the control ui gets every kind, the macos, ios
  and android apps exec only, the tui plugin only, `:185-195, 212-221`);
  `gateway-client` is on none of the lists, so without the cap boxbox would
  never hear an approval, and `approvals` covers all three kinds.
- **claiming `approvals` makes boxbox an approval route, a change in the
  gateway's behaviour.** the gateway counts boxbox as an approval client
  (`server-request-context.ts:197-223, 360-375`). a request with no
  approval client, no forwarder delivery and no turn-source route is
  denied at once as `no-approval-route`
  (`src/gateway/server-methods/approval-shared.ts:416-425`), and
  gateway-host cron cards go only to approval clients (`:343-347`). with
  boxbox connected, those requests (headless cron on the gateway host,
  turns with no channel) **wait for boxbox until they expire** (exec 30
  minutes) instead of failing closed at once. this is deliberate: every
  approval reaches boxbox. it is also why an approval must never be lost
  (5.9, holes 5 and 15): a lost ask stalls a job until its deadline. any
  approval that reaches expiry while raised in boxbox and unanswered gets a
  push when it was raised (as every ask does) and an
  `openclaw.approval_expired` telemetry row (labelled by kind, never by
  content).
- **`session-scoped-events`** is required. without it the gateway fans out
  `chat`, `agent`, `session.narration` and `session.tool` for **every**
  session to boxbox (`src/gateway/server-broadcast.ts:49-59, 359-388`: the
  subscription gate applies only to browser copilots and clients claiming
  this cap, `packages/gateway-protocol/src/client-info.ts:88`), visible
  `agent` events are not dropped when slow (`src/gateway/server-chat.ts:894`),
  and the subscription cap and shedding (5.5, 5.8) would do nothing. with
  the cap, live text arrives only for sessions boxbox subscribed to, **its
  own sends included**: no path gives the sender live text without a
  subscription (`src/gateway/server-methods/chat-broadcast.ts:158-175` only broadcasts),
  which is why a thread with a boxbox-started run in flight is admitted
  (5.5).
- **`tool-events`**: "accepts structured tool lifecycle events" (doc
  `handshake.md:257`). they are delivered only for runs this connection
  started, plus runs already active in that session at send time
  (`src/gateway/server-methods/chat-send-agent-dispatch.ts:425-440`), so
  live tool parts exist only for boxbox-started turns; channel turns show
  their tools from committed rows.
- **`chat-only-assistant-text`**: assistant text arrives on `chat` and the
  duplicate assistant-text `agent` stream is omitted (doc
  `handshake.md:265-266`). boxbox consumes `chat` only.
- nothing else. caps also decide which agent tools a turn boxbox starts may
  use: "the gateway omits those tools unless every requirement appears in
  the originating client's caps" (doc `handshake.md:268`). boxbox does not
  claim `inline-widgets`, `ui-commands` or any cap it cannot render, so a
  tool that needs one is simply absent from boxbox-started turns, as it is
  from whatsapp turns.
- the full list is `client-info.ts:79-99`.

### 3.6 one socket, one reader

- one websocket per connection, never two (a second doubles the gateway's
  fan-out for nothing).
- the reader task only reads, parses the envelope, checks the outer `seq`
  (5.4), hands answers and the connection's own events (`connect.challenge`,
  `shutdown`) to the connection's actor over a small channel of their own,
  and puts every other event on a bounded stream (4096 frames or 16 MiB,
  the bound `docs/agents.md` gives every socket source), so answers that
  already arrived are never held behind a consumer that is behind. while
  the reader waits for room, silence is not counted against the socket
  (3.7). past half the bound the source sheds subscriptions (5.8);
  full, the reader stops reading, which is what a slow consumer is, and
  the gateway's own 1008 or a reconnect follows (5.8); the cursors make the
  catch-up gap free. it never waits on the store writer or the fleet: the
  gateway closes a socket with 1008 once more than 50 mib is buffered for
  it (`src/gateway/server-broadcast.ts:462-466`;
  `src/gateway/server-constants.ts:4`).
- requests are correlated by `id` (a per-connection counter as a string);
  a response with no waiting request is logged and dropped.

### 3.7 dead sockets, reconnect, backoff

- **liveness:** any inbound frame resets a timer; at 2 x
  `policy.tickIntervalMs` of silence (the code constant is 30000,
  `server-constants.ts:14`, so 60 s; the doc example's 15000 is wrong)
  boxbox closes with 4000 and reconnects. the gateway sends `tick` every
  interval (`src/gateway/server-maintenance.ts:243-247`).
- **pings:** tungstenite answers server pings itself; boxbox also pings
  every 20 s and treats 25 s without a pong as dead (the server allows a
  peer 25 s, doc `docs/gateway/protocol/transport.md:188-200`).
- **request timeout:** 30 s. a timed-out request is **uncertain**, never
  failed: a send goes to reconciliation (7.1), an answer to its own (7.9,
  7.10), a read is simply retried.
- **backoff:** exponential from 1 s to 30 s with full jitter, reset after
  60 s of a healthy connection. (openclaw's reference client uses no jitter
  and resets on hello, `packages/gateway-client/src/protocol-client.ts:66-73, 364`;
  boxbox jitters because several boxbox lanes can share one gateway in dev,
  and resets later so a gateway that accepts and then drops does not get a
  tight loop.)
- **`retryAfterMs`** on any error (`frames.ts:178-184`) is a floor:
  startup sidecars (doc `handshake.md:163-166`), suspension, control-plane
  rate limits (`src/gateway/control-plane-rate-limit.ts:42, 66-76`).
- **queue full:** a retryable `UNAVAILABLE` with no `retryAfterMs` backs
  off 1, 2, 4 ... 30 s with jitter.
- **`shutdown`** (`frames.ts:25-28`): stop issuing requests and expect the
  close; `restartExpectedMs`, when present, sets the first retry.
- **close codes:** 1008 with reason "slow consumer" is 5.8. every auth
  refusal is a configuration error: no retry loop, the card says what the
  gateway said. any other 1008 after the hello is retried no sooner than
  the 30 s cap, with the gateway's words on the card: the gateway also
  closes with 1008 "gateway message handler loading" while it starts
  (`src/gateway/server/ws-connection/message-handler-loader.ts:15`), so
  treating every 1008 as configuration would wedge the connection after a
  restart. a 1008 during the handshake follows the `connect` answer
  before it, which is what decides (3.4).

### 3.8 agents from the gateway

- `hello-ok.snapshot.health.agents` lists every agent in `agents.entries`
  plus the default agent, each `{agentId, name?, isDefault, heartbeat,
  sessions}` (`packages/gateway-protocol/src/schema/snapshot.ts:194-214`;
  built at `src/gateway/health/collector.ts:81-101, 166-172`; `name` is the
  raw config name). `snapshot.sessionDefaults` gives `defaultAgentId`,
  `mainKey` and `mainSessionKey` (`snapshot.ts:219-227`).
- each entry becomes one boxbox agent. its key is
  `<connection>-<slug(agentId)>` unless the file pins `key`, persisted in
  `agents` once given (`docs/agents.md`). its label is `{name: <config
  name or file name or agentId>, source: "openclaw", machine: <connection
  name>}`, kind `assistant`, mark `round`.
- the `health` event carries later snapshots; an agent that appears gets an
  `agent` change, one that disappears gets `agent.removed` after two
  consecutive snapshots without it (a reload can briefly list fewer).
- openclaw's own avatar and emoji (`agents.entries.<id>.identity`) come
  from **`agents.list`** (allowlisted, section 4): `operator.read`
  (`core-descriptors.ts:155`), params exactly `{}`
  (`packages/gateway-protocol/src/schema/agents-models-skills.ts:86`), no
  side effects (it reads config, the prepared model catalog and avatar
  files). boxbox calls it once per connect and when the health agent set
  changes, and consumes only `id` and `identity.{name, emoji, avatarUrl}`
  (`agents-models-skills.ts:51-97`): `identity.name` feeds the label when
  the file pins no name. `avatarUrl` is an http(s) url or a `data:` url
  with a local avatar inlined as base64
  (`src/gateway/session-utils-store.ts:322-347`); the emoji and avatar are
  shown only once `docs/agents.md`'s agent shape carries them, and then
  the avatar bytes are copied once into the media store (section 8) and
  neither the url nor a `data:` string is kept. workspace paths, models and
  permission modes in the answer are dropped unread. a name or palette in
  boxbox's own file wins over the gateway's.

## 4. the allowlist

boxbox's openclaw client can send exactly these, and nothing else:

| family | websocket methods (as in the schema) | scope (core-descriptors) |
|---|---|---|
| handshake | `connect` | none |
| sessions | `sessions.list`, `sessions.subscribe`, `sessions.messages.subscribe`, `sessions.messages.unsubscribe` | operator.read |
| sessions | `sessions.create`, `sessions.patch` | dynamic |
| chat | `chat.send`, `chat.abort` | operator.write |
| chat | `chat.history` | operator.read |
| chat | `chat.message.get` (**conditional**, see below) | operator.read |
| agents | `agents.list` | operator.read |
| approvals | `exec.approval.list`, `plugin.approval.list`, `openclaw.approval.list`, `approval.get`, `approval.resolve` | operator.approvals |
| questions | `question.list`, `question.get`, `question.resolve` | operator.questions |
| media | `artifacts.download` | operator.read |
| reactions | `session.reactions.set` (write), `session.reactions.list` (read) | as named |
| models | `models.list` | operator.read |

and these http requests, to the gateway's own origin only:

| route | for |
|---|---|
| `GET /api/chat/media/outgoing/<encoded session key>/<id>/full?mediaTicket=<t>[&playback=1]` | managed media blocks, by ticket (8.2) |
| `GET /__openclaw__/assistant-media?source=<s>&sessionKey=<k>&agentId=<a>[&playback=1]` with the device token as bearer | media facts on rows (8.2) |
| `GET /api/artifacts/download/<connId>/<ticket>` | other artifact grants (8.2) |

**never**, whatever a client asks: `config.*`, `exec.approvals.*`,
`update.*`, `wizard.*` (all admin-reserved, doc `handshake.md:345-348`),
`device.*`, `node.*`, `gateway.restart.request`, `sessions.reset`,
`sessions.delete`, `sessions.compact`, `sessions.rewind`, `sessions.steer`,
`sessions.send`, `chat.inject`, `approval.history`, `question.waitAnswer`,
`agents.*` except `agents.list`, `agent.identity.get`, `cron.*`, `tts.*`,
`talk.*`, and every other method.

notes on the edges:

- the "list" of approvals is the three per-kind lists. `approval.history`
  stays out on purpose: an approval raised and settled while boxbox was
  away never needed the person, and its outcome is in the transcript.
  `approval.get` covers every id boxbox has seen (terminal records are
  kept 30 days, 5.9).
- **`chat.message.get` is in only behind a dev-gateway proof.** it is
  `operator.read` (`core-descriptors.ts:326`), params closed
  `{sessionKey, agentId?, messageId, maxChars? <= 2000000}`, answer `{ok,
  message?, unavailableReason?: not_found | oversized | not_visible}`
  (`logs-chat.ts:231-245`), no writes and no read-state change
  (`src/gateway/server-methods/chat-message-get-handler.ts:108`). like
  `chat.history` it restores a cold-stored transcript, so the archived
  rule (5.7) covers it. its value is doubtful: the archive reader marks a
  stored line over 256 kib `oversized` too
  (`src/gateway/session-transcript-archive-reader.ts:218-224`), the same
  cause as history's placeholder. so: boxbox sends exactly
  `{sessionKey, agentId, messageId, maxChars: 1000000}`, only for a row
  history answered with `reason: "oversized"` (hole 20), only in a thread a
  person has open, at most once per row. **the first dev-gateway run
  holds `openclaw_message_get_proof`** (section 12): a row history
  answers `oversized` comes back whole from `chat.message.get`. if it
  does not, this row, its `Allowed` variant and hole 20's use of it are
  removed before the openclaw milestone lands, and the row stays a
  placeholder.
- `agents.list`: params `{}`, read only; what boxbox keeps is 3.8.
- **`sessions.patch` is allowlisted field by field**: the only keys ever
  sent are `key`, `agentId`, `expectedSessionId` (always), and one of
  `model`, `thinkingLevel`, `unread` (with `expectedMarkedUnreadAt` on an
  automatic read, 7.6) or `archived`
  (`packages/gateway-protocol/src/schema/sessions-patch.ts:11-16, 41,
  49-53, 82, 96-100, 111`).
- **`sessions.create` is allowlisted field by field**: `agentId`,
  `idempotencyKey`, `key` (7.4), `model?`, `thinkingLevel?`. its schema
  also takes `message`, `task` and `attachments` (a first turn with no
  command suppression), `permissionMode`, `toolOverrides`, `incognito`,
  `parentSessionKey`, `fork`, `emitCommandHooks` and more
  (`packages/gateway-protocol/src/schema/sessions-create.ts:17-90`); boxbox
  sends none of them.
- **`chat.send` is allowlisted field by field**: `sessionKey`, `agentId`,
  `sessionId`, `expectedLeafEntryId` (7.1), `message`, `idempotencyKey`,
  `queueMode` (always `"followup"`), `replyToId`, `attachments`,
  `suppressCommandInterpretation` (always `true`, 7.2). never `thinking`
  (the chip patches the session, 7.5), `deliver`, `originating*`,
  `systemInputProvenance`, `systemProvenanceReceipt`, `toolBindings`,
  `intent`, `turnKind` or any other `expected*` field
  (`packages/gateway-protocol/src/schema/logs-chat.ts:312-350`). boxbox's
  device holds `operator.admin`, so a field like `originatingChannel`
  would be honoured (`src/gateway/server-methods/chat-send-request.ts:137-160`);
  the allowlist is what keeps boxbox from ever speaking for a channel.
- **defence in depth:** a unit test builds every patch and create boxbox
  can produce and asserts each classifies as `operator.write` under the
  gateway's own rule (`src/shared/session-method-scopes-base.ts:83-163`);
  `sessions.patch` otherwise accepts `permissionMode`, `sandboxMode`,
  `elevatedLevel`, `execHost`, `toolOverrides`, `sendPolicy` and more
  (`sessions-patch.ts:18-93`), and admin passes all of them
  (`src/gateway/method-scopes.ts:219-221`).

**how it is enforced.** every outgoing websocket frame goes through one
function, `openclaw::wire::send(&self, request: Allowed)`, where `Allowed`
is an enum with one variant per row above, each holding its generated
params struct (or the narrowed patch and send structs). there is no other
path to the socket's sink: the sink is owned by the writer half of the
connection task and `send` is its only caller. http fetches go through one
`openclaw::media::fetch(route: AllowedRoute)` the same way. `mode = "watch"`
is a check at the top of both.

**the test.** `openclaw_allowlist` (in the integration suite) runs the full
scripted scenario set against the dev gateway with `--ws-log` style frame
capture on boxbox's side: a tap in `wire::send` records every method name
and the top-level keys of every params object, and a tap in
`media::fetch` records every path. the test asserts the recorded set is a
subset of the table above, field lists included, and that the never list
is absent. a unit test asserts `Allowed` has exactly the variants above
(a new variant fails it until this table changes).

## 5. the sync algorithm

the rule underneath: **transcript sync is gap-free on `chat.history`'s
`deltaCursor`, never on `messageSeq`.** live events are accelerators; the
cursor is the truth.

### 5.1 the facts it rests on

- `chat.history` with no `offset` (or offset 0) is a **tail page**. it
  returns a `deltaCursor` only when the transcript source is active and no
  assistant error is pending (`src/gateway/server-methods/chat-history-page-kernel.ts:322-330`).
  the cursor is minted at the projection's indexed seq
  (`src/config/sessions/session-accessor.sqlite-history-query.ts:364-372`).
- passing it back as `cursor` returns `{kind: "delta", messages,
  deltaCursor, sessionInfo, pendingInputs?, inputReceipts?, activity?}` or
  a bare `{kind: "reset"}` (`logs-chat.ts:156-175`;
  `src/gateway/server-methods/chat-history-handler.ts:471-554`). a reset
  carries no cursor; recovery is always a fresh tail.
- a delta has no continuation. it is `reset` when the gap passes 200 raw
  events or 1 mb (`src/gateway/server-methods/chat-history-delta.ts:39-40,
  86-87`), when the range holds a reset, compaction or leaf event
  (`src/gateway/session-history-delta-visibility.ts:20-32`), on a channel
  delivery-mirror row (`chat-history-delta.ts:166-173`), on a tts supplement
  row (`:174-177`), when the projection needs a reset (`:194-195`), while an
  assistant error is pending (`:198-200`), and past its byte budget
  (`:208-210, 225-227`). the cursor itself resets on `invalid_cursor`,
  `scope_mismatch` (another sessionId) or `generation_mismatch`
  (`src/config/sessions/session-accessor.sqlite-raw-delta-read.ts:150-175`).
- `cursor` cannot be combined with `offset` or `messageId`
  (`chat-history-handler.ts:97-103`); `sessionId` is only legal with
  `messageId` (same lines).
- `messageSeq` is a display position (`session-accessor.sqlite-history-query.ts:281-329`).
  identity is the transcript entry id: `messageId` on `session.message`
  (`src/gateway/server-session-events.ts:541-551`) and `__openclaw.id` on
  history rows (`src/gateway/server-methods/chat-history-budget.ts:115-130`).
- limits: `limit` 1 to 1000, default 200; `maxBytes` at least 1024
  (`logs-chat.ts:35-53`), clamped to 6 mib (`server-constants.ts:11-13`);
  `maxChars` 1 to 500000, default 8000 per message
  (`src/gateway/chat-display-projection.helpers.ts:16`); `inputRunIds` at
  most 50, current sessionId only (`chat-history-handler.ts:221-241`).
- **the same row projects differently per read path.** `session.message`
  and delta rows ignore `maxChars` and are cut at the default 8000
  characters (`server-session-events.ts:541-551`;
  `src/gateway/server-methods/chat-history-delta.ts:54-61`). tails honour
  `maxChars`, and replace any single row over 128 kib serialised with the
  placeholder "[chat.history omitted: message too large]", `reason:
  "oversized"`, whatever `maxChars` says (`chat-history-budget.ts:14-15,
  103-139`; `chat-history-response-page.ts:38-46`); live and delta never
  use the placeholder. 5.2's merge rule handles this.
- **row shapes differ.** delta `messages` are `session.message`-shaped
  envelopes `{sessionKey, agentId, message, messageId, messageSeq, ...}`
  (`chat-history-delta.ts:180-215`; schema comment `logs-chat.ts:150-154`);
  tail rows are bare messages carrying `__openclaw.id`. neither carries the
  run's `runId` as an envelope field (`chat-history-delta.ts:180-193`);
  only `session.message` does (`server-session-events.ts:548`).
- every tail answer and every delta's `sessionInfo` carries the session's
  `sessionId` (`chat-history-handler.ts:562-565`); boxbox compares it with
  the stored one on every answer, not only on events, and runs 5.6 on a
  mismatch.
- `chat.history` can answer a retryable `UNAVAILABLE` "session changed
  while reading history; reload the conversation" with `retryAfterMs:
  250` (`src/gateway/server-methods/chat-history-recovery.ts:37-51`):
  retry the same read after the floor, without touching the stored
  cursor.
- `session.message` goes to every roster subscriber and every per-session
  observer (`server-session-events.ts:350-361, 553`), carries `messageId`,
  `messageSeq`, `runId` and the row snapshot, and is not dropped when slow.
  when the gateway cannot read the stored row it sends a keyed
  `sessions.changed {phase: "message"}` with no message instead
  (`server-session-events.ts:520-539`), also not dropped. several other
  paths skip `session.message` silently or leave only a `dropIfSlow`
  `sessions.changed` (a stale marker or lifecycle, rows suppressed from
  display, the legacy path with no agent: `server-session-events.ts:286-327,
  378-392, 486-498, 556-575`), so a row can arrive by delta after a later
  row arrived live (5.4, the order key), and a watched thread is swept
  sooner (5.4).
- every other `sessions.changed` is sent `dropIfSlow`
  (`src/gateway/server-methods/session-change-event.ts:152`); a dropped
  frame still consumes an outer `seq` number, so the client sees the gap
  (`server-broadcast.ts:442-460`).

### 5.2 what is persisted

no transcript mirror (`docs/agents.md`, the seam): the gateway is the
system of record for messages, as cmx2 is. a boxbox restart starts a new
journal epoch and clients re-hydrate threads through the server, which
answers from the bounded read cache below and reads through to the
gateway under the limits in section 10. what boxbox persists, all through
the store writer into `boxbox.db` except the read cache, which this
source writes to its own file:

| what | where | written when |
|---|---|---|
| device key (unless `device_key` is set), device token, instance id | `source_secrets` | first start, each new token |
| per connection: `lastBootId`, `lastServerVersion`, `featuresHash`, `lastConnectedAt`, `lastUptimeMs` | the connection row | each `hello-ok` |
| per session (`connection`, `agentId`, `key`): `sessionId`, `deltaCursor`, `cursorState` (`valid`, `none`, `needs_tail`), `lastMessageId`, `activeLeafEntryId`, `markedUnreadAt`, `updatedAt`, `archived`, `missingListings` | the per-session cursor row | after the rows the read produced are sent to the fleet channel (safe: a boxbox restart is a new epoch, and clients re-hydrate) |
| thread id for each (connection, agentId, key) | `thread_ids` | first sight |
| agent key for each (connection, agentId) | `agents` | first sight |
| open approval and question needs | the needs ledger (`fleet/needs.rs`), as today | raised and served |
| media bytes and their index | the media store (`docs/agents.md`) | first sight (section 8) |
| recent transcript rows, not authoritative | the read cache, `<data dir>/cache/<connection>.db` | after the merge rule, from reads already made (below) |

`deltaCursor` is stored as an opaque string under 4096 characters
(`session-accessor.sqlite-raw-delta-read.ts:49`); boxbox never parses it.
`lastMessageId` is the anchor for finishing an old generation (5.6). never
persisted: live text, outer `seq`, subscription bindings, approval and
question records (rebuilt from the lists on every connect, 5.9), and the
seen index.

**what is journaled.** every committed row of **every non-archived
thread** reaches the journal as a `message` (and its `part`s), watched or
not, as cmx2 journals every row of every session today: the roster
already delivers `session.message` for all of them, so this costs the
gateway nothing. a client that holds a thread stays current on the
journal's seq alone; when boxbox cannot prove it delivered every row of a
thread, it sends `thread.reset {key}` and clients drop their cached
transcript of that thread and hydrate it again (5.5). archived threads
are not journaled (5.7).

**the seen index** (`docs/agents.md`, the seam): in memory, owned by the
source, one per thread with a row journaled or hydrated this epoch: the
last 200 rows, each a 12-byte digest of the id, an 8-byte content hash,
the length and a truncated flag; at most 2,000 threads per connection,
lru. a row reaches the journal only when its id is new or its content
**grew**, so tails, deltas, hydrations and live frames that overlap apply
exactly once. it is the overlap set for tail reads (5.5). a hydration
read (a client opening a thread) registers the viewer first, then reads,
then seeds the index with the ids and hashes it served, so a row committed
during the read arrives by `session.message` and is not lost between the
read and the seed.

**the merge rule is monotone per id**, because the same row projects
differently per read path (5.1):

- the hash is over the projected body with `__openclaw.truncated` and its
  reason removed;
- a version whose text is a prefix of the held one counts as unchanged, so
  an 8000-character live or delta copy never replaces a 100000-character
  tail copy;
- a truncated version never replaces a longer or untruncated one;
- an `oversized` placeholder never replaces text; it is used only when
  boxbox holds nothing better for that id;
- a different body that is not a prefix (a tts merge rewriting a reply
  under the same id) is a change and is journaled.

**the read cache** (`docs/agents.md`, the seam, owns its shape and caps):
`<data dir>/cache/<connection>.db`, owned by this source, **not a system
of record**. per thread the last 200 rows or 2 MiB, whichever is smaller,
for threads active or opened in the last 30 days, 256 MiB across
connections (`[cache] transcript_bytes`), lru by last open. the openclaw
side of it:

- **filled only from reads boxbox already makes**: tails, deltas,
  hydrations and committed `session.message` rows, after the merge rule,
  so it never causes a gateway read;
- **served marked stale** (`x-boxbox-cache: stale`, else `fresh`) when
  the gateway is unreachable or the connection is refused, so a boxbox
  restart during a gateway outage still shows recent history; a thread the
  cache does not hold answers 503 `agent-down` while the gateway is
  unreachable;
- when the gateway is up, a hydration is answered from the cache and
  revalidated by one delta from the stored cursor (5.5, hydration), never
  by a fresh tail when the cursor is `valid`;
- **replaced wholesale** by a reset tail (one that sent `thread.reset`)
  and by a rewind or branch switch (5.6); dropped with `thread.removed`,
  archive, or the connection's removal;
- **never used to detect a gap**: cursors and the seen index do that.

### 5.3 cold start (no cursor rows for this connection)

1. connect and validate (3.3). store `bootId`.
2. install the event handlers first and buffer keyed events per session
   until that session is bootstrapped (events can precede the subscribe
   answer, doc `rpc-bootstrap-and-events.md:35-39`).
3. **roster:** `sessions.subscribe {limit: 100, archived: "all", rowMode:
   "compact", sortBy: "updatedAt"}`. it registers before it reads its
   snapshot and answers `{subscribed: true, list}`
   (`src/gateway/server-methods/sessions-subscriptions.ts:25-47`). page the
   rest with `sessions.list {offset: nextOffset, limit: 100, archived:
   "all", rowMode: "compact", sortBy: "updatedAt"}`, serially, advancing by
   `nextOffset` and deduping by key (doc `rpc-bootstrap-and-events.md:72-76`).
   each page is a preparation request (5.10, section 10).
4. **asks:** `exec.approval.list`, `plugin.approval.list`,
   `openclaw.approval.list`, `question.list` (5.9).
5. **threads:** every non-archived session becomes a thread (`thread`
   change, ids per `docs/agents.md`); archived ones become threads marked
   archived, never read (5.7).
6. **cursors:** enqueue a tail read (5.5) for every non-archived session
   active in the last 30 days, newest `updatedAt` first, one at a time
   (section 10). the tail's rows are journaled
   like any other (5.2) and seed the seen index; older history is a
   hydration or backfill read when a client asks (5.5). needs advance from
   the rows as for cmx2 (a reply that arrives later is news, never a
   backlog).
7. after a session's tail, apply its buffered events (at most 256 per
   session; past that the buffer is dropped and the session goes to
   `needs_tail`), then one delta from the tail's cursor. that closes the
   race between the tail and the subscription: what was committed after
   the tail's indexed seq is in the delta, what came before is in the
   tail, and the seen index collapses the overlap.

### 5.4 steady state

**the outer seq, first, on every frame.** event frames carry a
per-connection `seq` (`frames.ts:205-212`). on a gap: apply the frame if
it is a terminal `chat` event, then close with 4000 and take the warm path
(5.3 is never re-run for a gap). dropped frames can be `sessions.changed`
or approval events, so boxbox does not patch around a gap. the reference
client does the same (`packages/gateway-client/src/protocol-client.ts:459-478`).

**events:**

- `session.message`: merge into the seen index by (`sessionId` from the
  row snapshot, `messageId`) under 5.2's rule and journal it if new or
  grown, carrying `position` = the frame's `messageSeq` (below); set
  `lastMessageId`; mark the session dirty. a frame with no `messageId` only
  marks the session dirty. the thread's archived rule (5.7) applies first.
- keyed `sessions.changed`: merge the row (clearing and tombstone rules,
  doc `rpc-bootstrap-and-events.md:199-293`) into the thread. `phase:
  "message"` with no message, or any `messageId`/`messageSeq`, marks it
  dirty. a `reason` of `new`, `reset`, `compact`, `rewind`,
  `branch-switch` or `fork` sets `needs_tail`; `delete` with a `sessionId`
  is 6.9; a different `sessionId` is 5.6.
- keyless `sessions.changed` (`update`, `delete`, `cleanup`, `groups`):
  a debounced full roster re-list, at most once a minute.
- `chat` (per-session subscriptions only, 5.5; with `session-scoped-events`
  nothing else arrives, 3.5): live text for `runId`, section 6.2.
  `session.narration` replaces the live text for narration subscriptions.
- `session.tool` (cap `tool-events`, boxbox-started runs only, 3.5):
  updates the running tool part.
- approval, question and `session.approval` events: 5.9.
- `session.reaction`: 7.11.
- `health`: agents (3.8). `tick`: liveness and a clock sample (6.7).
  `shutdown`: 3.7.

**the delta worker.** a dirty session is drained by a single-flight delta
per session: 300 ms after the last trigger, one in flight per session,
triggers during a flight coalesce into one follow-up, global limits in
section 10. `delta` applies as one step: journal the new and grown rows,
store the new cursor, update the thread from `sessionInfo` (its
`sessionId` compared first, 5.1). an empty `messages` with a new cursor is
normal (non-displayed events moved it). `reset` is 5.5.

**order: the order key.** journal order can differ from transcript order:
when `session.message` is skipped for row n (5.1) and row n+1 arrives
live, row n reaches the journal later by delta. every journaled message
therefore carries `position` (`docs/agents.md`'s message field), built
from the row's `messageSeq`: from `session.message` and delta envelopes
directly, and on tail rows from `__openclaw.seq`
(`chat-history-budget.ts:116-131` keeps it even on a placeholder).
`messageSeq` is reset-relative ("raw cursor progress carries the same
reset-relative ordinals as pages and live messages",
`session-accessor.sqlite-history-query.ts:281`): it restarts after each
reset boundary. so `position` = the thread's base + `messageSeq`, where
the base is 0 at the first read this epoch and, when a new reset marker
is journaled, becomes the highest position journaled before it. the base
lives beside the seen index. clients place a message by `position`,
never by arrival. it orders rows and identifies none (identity stays the
transcript id, 5.1).

**the safety sweep.** every 10 minutes, a delta for each session updated in
the last 24 hours or running, at most one per second; a watched thread (on
stage, or with a window) is swept every 60 s, because several silent skips
(5.1) leave only a `dropIfSlow` change and no seq gap. an empty delta reads
no message bodies (`session-accessor.sqlite-raw-delta-read.ts:182-215`), so
this is cheap.

### 5.5 per-session subscriptions, tails and resets

**why subscribe per session at all.** the roster already delivers every
committed row as `session.message`. a per-session
`sessions.messages.subscribe` adds what the roster cannot: live `chat` text
(for any turn, boxbox's own included: with `session-scoped-events` an
unsubscribed thread gets no live text at all, 3.5), `session.approval`
with exact terminal states, and `session.tool`. `session.approval` goes
only to per-session subscribers that asked `includeApprovals`
(`src/gateway/operator-approval-session-events.ts:75-96`).

**params** (`packages/gateway-protocol/src/schema/sessions.ts:493-517`):
`{key, agentId, subscriptionId, mode?: "narration", includeApprovals?:
true}`; unsubscribe `{key, agentId, subscriptionId}`. the
`subscriptionId` is one stable id per (boxbox instance, session). the
gateway's registry is per connection (`src/gateway/server-chat-state.ts:572-592`),
so a reconnect starts with no subscriptions and boxbox subscribes again;
within one connection the same (connection, key, id) is one owner whose
newest commit wins (`:588-620`), so a mode change is a repeat subscribe
with the same id.

**the cap is 8 per connection.** the gateway has no per-connection cap
(`server-chat-state.ts:572-635`); the control ui caps itself at 6, which
the observer's model-call cap matches (`src/gateway/session-observer.ts:60`
is that model-call cap). boxbox admits, in order:

1. a thread on stage on a looking device (presence, decision 23): **full**,
   `includeApprovals: true`;
2. a thread with a boxbox-started run in flight (a send boxbox made whose
   run has not reached a terminal `chat` event): **narration**, no
   approvals, released at the run's terminal;
3. a thread with a window whose session `status` is running: **narration**,
   no approvals;
4. nothing else.

over the cap, the oldest admission of the lowest class is released first;
a thread beyond the cap still shows committed rows and "running" from the
row, with no token stream. release: unsubscribe 60 s after the last viewer
leaves, or when the run ends and nobody watches. `includeApprovals: true`
makes the subscribe a preparation request
(`src/gateway/server/ws-connection/request-start.ts:110-115`) whose
response carries up to 1000 pending approvals as `approvalReplay`
(`MAX_SESSION_APPROVAL_REPLAY`, `src/gateway/operator-approval-session-events.ts:30`;
`src/gateway/server-methods/sessions-subscriptions.ts:146-237`), not as
events, so at most one such subscribe is in flight.

**order: subscribe first, then read** (doc `rpc-bootstrap-and-events.md:123-125`).

**tail read (adaptive):**

1. `chat.history {sessionKey, agentId, limit: 50, maxBytes: 1 MiB,
   maxChars: 100000}`.
2. if the response carries `deltaCursor`, store it, `cursorState = valid`;
   otherwise `none` (6.13). compare the answer's `sessionId` (5.1).
3. **overlap test.** the tail joins what clients hold, and boxbox
   journals its new and grown rows, runs supersede reconciliation and
   stops, when any of these holds:
   - the oldest returned id is in the thread's seen index;
   - the tail holds a reset marker whose id is new (a `/new` or `/reset`
     since the last read: the window starts at the boundary, 5.6); the
     marker and the post-boundary rows are journaled and no
     `thread.reset` is sent;
   - the thread has **never been journaled or hydrated this epoch** (no
     seen index exists for it, and no client can hold rows of it from
     this epoch). a thread whose index was evicted from the lru does not
     pass this way: it is treated as non-overlapping.
4. otherwise, if the answer says `hasMore: false` (the whole visible
   window came back, `chat-history-response-page.ts:72-75`) without
   overlap, go to 5 at once; else double the limit (100, 200, 500, 1000)
   with `maxBytes` growing to 6 MiB, and repeat.
5. at 1000 rows, or `hasMore: false`, with no overlap: keep the tail,
   journal it, replace the thread's read cache with it, and send
   **`thread.reset {key}`**: clients drop their cached transcript of the
   thread and hydrate it again (the gap is older than anything boxbox can
   prove it delivered).

**supersede reconciliation:** the tail is authoritative from its oldest
**post-boundary** row forward. ids in the seen index that were journaled
after that row's position and are absent from the tail get
`message.removed`; rows before it are left alone. it is skipped
altogether when the tail holds a reset marker, because idle and daily
resets keep only user and assistant rows before the boundary
(`context: "preserve-tail"`, `src/auto-reply/reply/session-hooks.ts:36-43`;
`src/config/sessions/session-reset-boundary-event.ts:61-68`), and the
pre-reset tool rows clients hold are earlier history, not removed rows.

**reset (`kind: "reset"`):** set `needs_tail` and read the tail at once.
reset is normal, not an error: every channel reply writes a delivery-mirror
row that forces one (`chat-history-delta.ts:166-173`), as do tts
supplements, compaction, errors and long gaps. a 50-row tail usually
overlaps at once. **loop guard:** more than 6 resets on one session in 60 s
throttles its tails to one per 10 s.

**hydration** (a client opens a thread whose rows it does not hold, or
re-hydrates after `thread.reset` or a new epoch): one read-through per
thread at a time, shared by every client that asked (single flight), at
most 2 a second per connection. register the viewer, then read, then seed
the seen index (5.2). when the read cache holds the thread and its cursor
is `valid`, the answer is the cached rows revalidated by one delta from
the cursor; otherwise one tail (`limit: 200, maxBytes: 2 MiB,
maxChars: 100000`). a hydration of an archived thread is the person
opening it (5.7).

**backfill** (a client scrolls up past what it holds): `chat.history
{sessionKey, agentId, offset, limit: 200, maxBytes: 2 MiB}`, answered to
that client only, never journaled. **never store a cursor from a backfill
page**: an `offset: 0` page and a `windowReset` answer do carry
`deltaCursor` (`chat-history-page-kernel.ts:316-330`). a `windowReset:
true` answer means the offset rebased to 0: discard the page and answer
the client with "history moved; reopen the thread". offset pages reach
only the current reset window
(`src/config/sessions/session-accessor.sqlite-reset-window.ts:222-233`).
**across a reset boundary**, when the oldest row the client holds is a
reset marker (or the window's first row), backfill is `chat.history
{sessionKey, agentId, messageId: <the marker's id>, limit: 200, maxBytes:
2 MiB}`: an anchored read inside the previous interval (previous reset,
this reset] (`src/config/sessions/session-accessor.sqlite-history-interval.ts:350-404`). the
anchor page is centred (`src/sessions/transcript-anchor-page.ts:52-63`),
so the client re-anchors on the oldest row it got to go further back.

### 5.6 session lifecycle under one key

- **`/new`, `/reset` and `sessions.reset` keep the `sessionId`**, mint a
  new lifecycle revision and append a reset boundary
  (`src/gateway/session-reset-service.ts:1132, 1153`). the next delta
  resets; boxbox reads the tail, which starts at the boundary: the
  history window is bounded by the latest reset
  (`session-accessor.sqlite-reset-window.ts:222-233`), and with context
  `clear` nothing is kept before it
  (`session-reset-boundary-event.ts:78-83`). the tail's new reset marker
  makes it join (5.5 step 3): the marker and the rows after it are
  journaled, no `thread.reset`. the rows before it stay in clients and in
  the read cache as the thread's earlier history (never
  `message.removed`); the boundary becomes a `marker` part (`reset`) so
  clients can draw "new session" there. the pre-reset rows stay in the
  same sqlite transcript, hidden from offset pages and reachable by a
  `messageId`-anchored read (5.5, backfill across a boundary).
  `lifecycleRevision` is on neither `sessions.changed` nor
  `session.message` rows, so boxbox uses the event `reason`, the reset
  marker, the `sessionId` comparison and cursor resets. `Thread.generation`
  does not change on `/new` (7.1).
- **rewind, branch switch, acp rotation and restart-tombstone forks change
  the `sessionId` under the same key**
  (`src/config/sessions/session-accessor.sqlite-message-cut.ts:267, 459`;
  the row carries `previousSessionId`, `sessions-row.ts:250`). the thread's
  `generation` changes, and:
  - **rewind and branch switch** (`reason: "rewind" | "branch-switch"`):
    the new sessionId's transcript holds the kept prefix with the same
    ids, then a leaf (`session-accessor.sqlite-message-cut.ts:274-285`).
    boxbox stores the new `sessionId`, clears the cursor and reads the
    tail, which overlaps by those ids; supersede reconciliation (5.5)
    removes the cut rows (journaled ids after the tail's oldest row and
    absent from it) with `message.removed`. that is the gateway's view:
    cut rows leave the active path. the read cache is replaced by the
    tail. no old-generation read is made.
  - **every other `sessionId` change** (acp rotation, a restart-tombstone
    fork, or a switch whose `reason` boxbox missed): first finish the old
    generation, so rows committed between the last cursor and the switch
    are not lost: `chat.history {sessionKey, agentId, sessionId: <old>,
    messageId: <lastMessageId>, limit: 200}`. the anchor page is centred
    (`src/sessions/transcript-anchor-page.ts:52-63`), giving at most 100
    newer rows, so boxbox loops: journal the rows after the anchor,
    re-anchor on the newest returned id, and stop when a page's newest row
    is its anchor. an answer that the `sessionId` does not belong to the
    `sessionKey` means nothing is left to finish
    (`chat-history-handler.ts:131-166`; the old id stays readable only
    while its `session_windows` row exists). a `messageId` read can fall
    back to the legacy file reset archive
    (`chat-history-page-kernel.ts:238-245`); sqlite `/new` rows do not
    live there. then store the new `sessionId`, clear the cursor and read
    the tail; the old generation's rows keep their ids and stay before the
    switch.
- **archive**: 5.7. **delete**: 6.9.

### 5.7 archive

- archive and unarchive are `sessions.patch {archived}`; there is no
  `sessions.archive` method and the list filter is `archived: true | false
  | "all"` (`packages/gateway-protocol/src/schema/sessions-list.ts:95-99`).
  the change arrives as a keyed `sessions.changed`; the row's `archived`
  and `archivedAt` (`sessions-row.ts:154-157`) are the truth, read from the
  row, since the patch emit itself carries no archive fields
  (`src/gateway/server-methods/sessions-patch-effects.ts:48-59`).
- on archive: release its subscription, keep its cursor row, stop sweeping
  and journaling it, drop its read cache entry. one final delta right
  after is fine (the transcript is still hot).
- **boxbox's own threads auto-archive.** `dashboard:` keys, which are the
  keys boxbox creates (7.4), are archived after 7 idle days by default
  (`src/config/sessions/store-maintenance.ts:25, 377-410`,
  `archiveReason: "stale-dashboard"`), and an archived session refuses new
  work ("Session ... is archived. Restore it before starting new work.",
  `src/config/sessions/lifecycle.ts:115-116`). boxbox shows an
  auto-archived session as archived, like any other. **a send into an
  archived thread first un-archives it**: `sessions.patch {key, agentId,
  expectedSessionId, archived: false}` (7.7), then, once the row shows
  `archived` false, the send (7.1). a patch that fails on
  `expectedSessionId` fails the send with "the conversation changed;
  review and resend", and nothing is sent.
- **never auto-read an archived session.** it is read only when a person
  opens it. the rule stays even though archive is not what triggers a
  restore: cold storage is opt-in (`session.maintenance.coldStorage.enabled`,
  `src/config/zod-schema.session-config.ts:68-73`) and keyed by idle time
  (`afterDays`, default 30, `src/config/sessions/session-cold-storage.ts:598`),
  and a `chat.history` (or `chat.message.get`) of a cold session restores
  it, one write on the gateway (`src/config/sessions/session-cold-storage-read.ts:59-78`).
  boxbox reads only sessions active in the last 30 days, and archived ones
  only when opened, so it never triggers a restore on its own.
- retention archives rather than deletes (`session.maintenance.pruneAfter`
  30 days, `maxEntries` 5000, `src/config/sessions/store-maintenance.ts:24,
  27`); a 10 GiB disk budget (`:32`) can extract historical sessions
  oldest first; cron run sessions are deleted after 24 h by default
  (`src/cron/session-reaper.ts:28`), which reaches boxbox as a delete (6.9).

### 5.8 warm reconnect, gateway restart, 1008

**warm reconnect** (cursor rows exist):

1. connect and validate; compare `bootId` with `lastBootId` (below).
2. re-run the roster subscription and paging as in 5.3.3 (a subscription
   does not survive a reconnect, doc `rpc-bootstrap-and-events.md:39`) and
   diff it against the cursor rows: a new key is a new thread (6.8); a
   different `sessionId` is 5.6; a flipped `archived` is 5.7; a key absent
   from a full `archived: "all"` listing increments `missingListings`, and
   two in a row is a delete (6.9).
3. a delta for every `valid` session, newest first; a session whose
   `updatedAt` did not move and shows no run goes to the low-priority
   sweep. `none` and `needs_tail` sessions get a tail. a thread with an
   archived row is skipped (5.7).
4. per-session subscriptions per 5.5 (the gateway's registry is per
   connection, so every admitted thread subscribes again), at most 2
   subscribe calls a second.
5. asks: 5.9. sends: reconcile every send still `checking` (7.1) before any
   new send on that thread.

**gateway restart.** detected on a successful hello by
`hello-ok.server.bootId` (a fresh uuid per gateway process,
`src/gateway/server-kernel.ts:151`; optional in the schema, `frames.ts:100`)
differing from `lastBootId`. with no `bootId`, fall back to
`snapshot.uptimeMs` (`snapshot.ts:241`) being smaller than the uptime
boxbox last saw plus the time since, minus 5 s. a `shutdown` event before
the close is a hint, never relied on (a crash sends nothing). on a restart:

1. transcripts: cursors are durable sqlite coordinates, so the warm path
   applies unchanged. a turn cut mid-stream is resumed by the gateway (doc
   `docs/gateway/restart-recovery.md:9-26`) and its rows arrive by delta.
2. live text: cleared; the resumed turn's first frame per recipient is a
   full snapshot (doc `rpc-bootstrap-and-events.md:138-146`).
3. approvals: every approval that was pending was closed at boot by
   `closeOrphanedOperatorApprovals`
   (`src/gateway/server-aux-handlers.ts:99-109`) as `cancelled`, decision
   deny, reason `gateway-restart`, resolver `{kind: "system"}`, with no
   event (`src/gateway/operator-approval-store.transitions.ts:282-338`).
   terminal records are kept 30 days
   (`src/gateway/operator-approval-store.rows.ts:29`), so boxbox calls
   `approval.get` for each, settles the ask (`outcome: "cancelled"`,
   `reason: "gateway-restart"`), and adds a `notice` text part to the
   thread: "the gateway restarted and cancelled this approval; the agent
   will ask again if it still needs to".
4. questions: they are in memory on the gateway
   (`src/gateway/question-manager.ts:125`) and are gone with no event;
   `question.get` answers not found. boxbox settles each (`outcome:
   "cancelled"`, `reason: "gateway-restart"`) with "the gateway restarted
   and dropped this question".
5. sends: the gateway's in-memory idempotency map is gone
   (`server-constants.ts:16-17`); reconciliation (7.1) runs before any
   resend.
6. store the new `bootId`.

**1008 "slow consumer".** the gateway closes a socket that has more than
50 mib buffered when a frame it will not drop is queued
(`server-broadcast.ts:462-466`). no data is lost: reconnect warm with
backoff, and everything comes back through cursors and lists. shed
before it comes to that: past half the reader channel's bound (8 MiB of
16, 3.6), downgrade every full subscription to narration and then release
all but the on-stage ones; after two 1008 closes in 10 minutes, run 30
minutes degraded (no full subscriptions, narration for at most 2
threads), with `openclaw.slow_consumer` telemetry. self-inflicted seq gaps
from dropped `dropIfSlow` frames follow the same rule. a 1008 with any
other reason is a configuration error (3.7).

### 5.9 approvals and questions

**live:**

- `exec.approval.requested`, `plugin.approval.requested`,
  `openclaw.approval.requested` (the event names,
  `src/gateway/server-methods-list.ts:84-91`): the event is `{approvalKind?,
  id, request, createdAtMs, expiresAtMs}`
  (`src/gateway/server-methods/approval-shared.ts:47-56, 129-143`).
  **the thread is `request.sessionKey` + `request.agentId`**: every
  approval kind carries its source session in those two fields
  (`src/gateway/server-methods/approval-record-lookup.ts:69-76`; exec
  builds them at `src/gateway/server-methods/exec-approval.ts:334-338`).
  boxbox's request decoder keeps **exactly those two fields** of
  `request` and drops the rest unread and unstored (it carries command
  text, cwd and environment). raise a pending ask on that thread from
  `{id, createdAtMs, expiresAtMs}`, then `approval.get {id}` for the
  reviewer-safe `presentation` and `status`. **`approval.get` never picks
  the thread**: for a pending record it returns only `{id, status,
  presentation, urlPath, createdAtMs, expiresAtMs}`
  (`src/gateway/operator-approval-snapshot.ts:9-19`;
  `src/gateway/server-methods/approval.ts:55-62, 286-291`), and the
  pending schema's `sourceSessionKey` is set only when projected into a
  session-scoped reviewer surface (`approvals.ts:223-224`), which
  whatsapp-turn threads never have. a request whose two fields are absent
  or name no known session raises the ask on the agent's main thread with
  a `notice` "raised outside a conversation".
- `*.approval.resolved`: `approval.get {id}` for the terminal snapshot,
  which alone adds `source.{agentId, sessionKey}` and `resolver {kind:
  device | channel | runtime | system, id?}` (`approval.ts:63-78`;
  `approvals.ts:203-218`); the event alone cannot tell expiry from deny
  (expiry publishes decision deny for exec and plugin,
  `src/gateway/server-methods/approval-publication.ts:54-67`).
- `session.approval` (full subscriptions): authoritative pending and
  terminal states for that thread, `expired` included
  (`approvals.ts:325-351`); it carries `sourceSessionKey`.
- `question.requested`: raise a question ask from the record
  (`packages/gateway-protocol/src/schema/questions.ts:114-125`).
- `question.resolved {id, status, answers?}`: settle it.

**on every connect, and every 5 minutes while connected:**

1. the approval lists (bare arrays, no paging), each entry the same shape
   as the requested event, its thread from `request.sessionKey` and
   `request.agentId` (`approval-record-lookup.ts:134-161`). a list whose
   method is not in `features.methods` is skipped
   (`openclaw.approval.list` is optional, 2.5); `openclaw.approval.list`
   entries carry no `approvalKind`
   (`src/gateway/server-methods/system-agent-approvals.ts:5-18`), so the
   kind comes from which list answered (`system-agent`, hole 22). every id
   in them is pending. every locally pending id absent from them gets
   `approval.get`; not found means it settled where boxbox cannot see it
   (`outcome: "unknown"`).
2. `question.list`. a locally pending id absent from it gets
   `question.get`; records stay 15 s after a terminal state, so not found
   means closed with an unknown outcome, "likely expired" when the skewed
   server clock is past `expiresAtMs`.

**at each raised ask's deadline:** `approval.get` (or `question.get`) at
`expiresAtMs` plus 5 s on the skewed clock (6.7), so an ask never outlives
its deadline by more than seconds: plugin approvals default to 2 minutes
and system-agent approvals to 10 (hole 6), well inside the 5-minute poll.
an approval that reached expiry unanswered settles `expired` and writes
the `openclaw.approval_expired` row (3.5).

approvals are durable sqlite rows (`operator_approvals`, terminal ones kept
30 days, `src/gateway/operator-approval-store.rows.ts:29`); questions are
in memory (`src/gateway/question-manager.ts:125`, 15 s grace after a
terminal state, `:28`). both lists are cheap.

**visibility.** with `operator.admin`, boxbox sees every approval,
including ones raised in whatsapp turns. without it a device sees only
approvals naming it as reviewer, unbound ones, or ones it requested
(`src/gateway/operator-approval-authorization.ts:33-54`;
`src/gateway/server-methods/approval-record-lookup.ts:112-114`).

### 5.10 what each step costs the gateway

the gateway shares **4 preparation slots** across all clients:
`sessions.subscribe`, `sessions.list`, `models.list`, and
`sessions.messages.subscribe` with `includeApprovals` (`request-start.ts:50,
110-115`). the 16-per-connection queue is the **control** budget, only for
small `sessions.messages.(un)subscribe` frames without approvals
(`request-start.ts:38-44, 112-118`); everything else (`chat.history`,
`sessions.list`, `artifacts.download`) queues against the work budget, 256
per connection and 1024 and 50 mb gateway-wide (`request-start.ts:30-37`).
control-plane rate limits (30 a minute per method per device,
`src/gateway/control-plane-rate-limit.ts:7-8`) apply only to
`controlPlaneWrite` methods (`core-descriptors.ts:4-5`), not to
`chat.history`, `sessions.list` or `artifacts.download`. a 50-row tail is
an indexed sqlite range read in a worker with a recent-window cache
(`session-accessor.sqlite-history-query.ts:440-458`), not
preparation-class. section 10 turns this into boxbox's budget.

## 6. every hole and its fix

numbered so tests can name them (section 12). each was re-checked against
the pinned tree.

1. **events between a snapshot and its subscription.** roster: the
   subscription registers before the list is read; buffer, apply the list,
   then re-apply buffered rows whose `updatedAt` is not older, and re-list
   once if a keyless event arrived meanwhile. transcript: subscribe the
   roster, then tail, then delta from the tail's cursor; the seen index
   collapses duplicates (5.3.7).
2. **live text versus the committed row.** live text is memory only, keyed
   by (session key, `runId`): the first `chat` delta per recipient carries
   the whole `message`, later ones `deltaText`, and `replace: true`
   replaces (`logs-chat.ts:416-423`). on `final`, `aborted` or `error`
   (`:426-442, 492-501`) the text stays, marked settling, until the run's
   committed row retires it: the first committed assistant row carrying
   the run's `runId` on `session.message` (`server-session-events.ts:548`)
   at or after the run's terminal `chat` event, since delta
   and tail rows carry no `runId` envelope (5.1) and one run can commit
   several assistant rows (earlier ones are journaled beside the live
   text). a committed row that reaches boxbox only by
   delta cannot be matched, so after 10 s with no match boxbox forces a
   delta or tail, then drops the live text anyway (a final can differ from
   its stream, and some runs commit nothing visible, doc
   `docs/gateway/protocol/rpc-session-control.md:54`). clients get live
   text as a **provisional message** (`docs/agents.md`, the stream): its
   parts stream as `part` and `delta` changes, and the retiring row
   replaces it with `message.removed` and then the real message, in one
   append. at most 8 runs per connection hold live text, 256 KiB each (a live row
   is at most 8000 characters, 5.1); past
   either the oldest is dropped to committed rows only.
3. **a send whose ack was lost.** reconcile by receipt before any resend
   (7.1).
4. **a send across a gateway restart.** durable custody covers ordinary
   input to an existing session; creation, commands and goals do not (7.1).
5. **an approval resolved elsewhere** (whatsapp, the control ui, a phone
   app). the resolved event arrives only with cap `approvals`, and is
   `dropIfSlow`, so a loss is a seq gap and a reconnect. boxbox always
   follows with `approval.get` and settles the ask from the terminal
   snapshot's `resolver` (7.9): `device` with boxbox's own device id is
   boxbox's answer; another `device` is "answered on another device";
   `channel` is "answered on <channel>" for any chat channel, not only
   whatsapp; `runtime` is a device-less client or auto-review; `system`
   is expiry, no route, a gateway restart or a run abort, told apart by
   `status` and the terminal reason. a late answer from boxbox gets
   `{applied: false, approval}` (`approval.ts:353-365`): `applied` alone
   does not say whose answer won, `resolver` does.
6. **question expiry.** `expiresAtMs` is gateway wall time (default 15
   minutes). expiry sends `question.resolved {status: "expired"}`; across a
   disconnect, 5.9 reconciles. clients count down on the skewed server
   clock and lock answering 5 s before expiry. approvals expire to an
   `expired` snapshot: exec 30 minutes (`src/infra/exec-approvals-core.ts:279`),
   plugin 2 minutes (`src/infra/plugin-approvals.ts:80`, at most 10),
   system-agent 10 minutes (`src/infra/system-agent-approvals.ts:40`). the
   5-minute poll is no backstop for the short ones, so each raised ask is
   checked at its deadline plus 5 s (5.9).
7. **clock skew.** `hello-ok` carries no wall clock. boxbox samples `tick.ts
   - local receive time` every tick, keeps the median of the last 10, logs
   more than 2 s. it is used for countdowns, pre-expiry locks and the
   restart fallback, never to order anything: transcript order is
   `position` (5.4).
8. **sessions created while disconnected** appear as new keys in the
   reconnect diff and get a tail and a delta; created-and-archived ones
   become archived threads, read only when opened. subagent sessions are
   ordinary rows with `parentSessionKey` and become threads with a parent.
9. **deletes.** a keyed `sessions.changed reason: "delete"` carries the
   removed generation's `sessionId` and no row
   (`src/gateway/server-methods/sessions-delete.ts:356-363`): only that
   generation is gone; a replacement with another `sessionId` is never
   removed (doc `rpc-bootstrap-and-events.md:289-293`). the thread gets
   `thread.removed` when no generation remains. a key missing from two
   consecutive full listings is deleted too.
10. **very long sessions.** tails stop at 1000 rows and 6 mib; deltas reset
    past 200 events or 1 mb, so a long disconnect becomes a tail plus
    on-demand backfill, never one huge read.
11. **a protocol or schema change on an upgrade.** 2.5: refuse on protocol,
    connect untested on version, disable verbs whose methods vanished,
    tolerant decode, the decode guard.
12. **delivery-mirror resets on every channel reply.** cheap by the
    adaptive tail (5.5).
13. **a tail with no cursor** (an assistant error pending, a non-active
    source, a claude-cli binding which always resets,
    `chat-history-handler.ts:473-475`): `cursorState = none`; every dirty
    trigger reads a tail instead of a delta, at most once per 5 s per
    session, until a tail returns a cursor.
14. **a row the gateway failed to read** arrives as keyed `sessions.changed
    {phase: "message"}` with no message (`server-session-events.ts:520-539`):
    a dirty trigger, and not dropped when slow.
15. **approvals with `suppressDelivery` emit no requested event**
    (`approval-shared.ts:356-371`), by design: they are never meant for a
    person. either the runtime resolves them itself within the same
    request (`src/agents/bash-tools.exec-host-node.ts:317-327`), or they
    are node-host cron requests denied at once as no-route
    (`approval-shared.ts:416-425`). they settle at once; one seen in a list
    race settles on the next `approval.get`.
16. **a seq gap from dropped frames**: close and reconnect warm (5.4).
17. **a restart silently cancels approvals and drops questions**: 5.8.
18. **rows committed between the last cursor and a `sessionId` switch**:
    the looping anchored read from `lastMessageId` (5.6), or, for a rewind
    or branch switch, the new transcript's copy of the kept rows.
19. **reading an archived session restores it** from cold storage: never
    auto-read (5.7).
20. **rows truncated for history.** a row past the display cap comes back
    with its text cut and `__openclaw: {truncated: true, reason:
    "display-cap"}` (`src/gateway/chat-display-projection.sanitize.ts:569-580`);
    a row too big for a history page becomes the text "[chat.history
    omitted: message too large]" with `reason: "oversized"`
    (`chat-history-budget.ts:15, 103-139`; a transcript line over 256 kib,
    `src/gateway/session-transcript-record-parser.ts:19-23, 255-266`).
    boxbox reads tails with `maxChars: 100000`, the practical ceiling:
    any row over 128 kib serialised comes back as the placeholder whatever
    `maxChars` says (`chat-history-budget.ts:14-15`), so a larger re-read
    would only produce a placeholder. there is no re-read of a
    `display-cap` row: its 100000-character copy is kept, with a `notice`
    "cut here; the rest is on the gateway", and 5.2's merge rule keeps the
    longest copy any path delivered. an `oversized` placeholder never
    replaces text boxbox holds (5.2); when boxbox holds nothing better it
    is a placeholder part, "too large to show here; open it on the
    gateway", and, while `chat.message.get` is allowlisted (section 4,
    conditional), one `chat.message.get {sessionKey, agentId, messageId,
    maxChars: 1000000}` when a person has the thread open, at most once per
    row; an answer of `unavailableReason: "oversized"` keeps the
    placeholder (`src/gateway/server-methods/chat-message-get-handler.ts:196,
    236, 266`). live and delta copies are cut at 8000 characters (5.1).
21. **the default queue mode steers.** a `chat.send` during a running turn
    with no `queueMode` is steered into that turn: steer is "the default,
    no config needed" (doc `docs/concepts/queue-steering.md:11`; admission
    at `src/gateway/server-methods/chat-send-admission.ts:279-282`). boxbox
    always sends `queueMode: "followup"` (7.2).
22. **the approval kind for openclaw's own approvals is `system-agent`**,
    not `openclaw` (`approvals.ts:16-20`), though its list method and
    events are named `openclaw.approval.*`. a wrong `kind` is a forced deny
    (7.9).
23. **any extra or wrong field on `approval.resolve` denies the approval**:
    `forceMalformedDeny = !validParams || !kindMatches || !decisionAllowed`
    (`src/gateway/server-methods/approval.ts:372-379`), and a decision the
    store finds not allowed is forced to deny too (`:160-161`); a present
    but invalid or null `reviewer` answers not found instead
    (`approval.ts:299-303`). a resolve of an already terminal approval never
    denies: the terminal check comes first (`:353-365`).
24. **slash commands run with boxbox's admin scope.** `chat.send` text such
    as `/config set ...` is interpreted as a command, and admin-only
    commands accept an admin client (doc `handshake.md:350-353`). boxbox
    sends `suppressCommandInterpretation: true` on every send (7.2), which
    needs admin itself (3.3 step 7). with admin the turn also runs as the
    owner (`senderIsOwner = hasGatewayAdminScope`,
    `src/gateway/server-methods/chat-send-session.ts:198`), so owner-only
    agent tools are available, as for the owner on whatsapp: a literal
    "/config set ..." still reaches the model as text and the model may act
    on it with its tools. approvals gate that path, not command parsing.
25. **caps decide a turn's tools** (doc `handshake.md:268`): boxbox claims
    only what it renders (3.5).
26. **attachments that fit `policy.attachments` can still overflow the
    frame**: base64 makes a 20 mb file about 26.7 mb, past the default 25
    mib `maxPayload` (doc `handshake.md:112-119`; `server-constants.ts:3`).
    boxbox checks the encoded request against `maxPayload` before sending
    (8.1).
27. **media urls expire and media records die with their generation**:
    tickets last 5 minutes. a managed record stays servable while its row
    is in the session's current generation: compaction keeps it
    (`session-accessor.sqlite-reset-window.ts:65-71`), but a reset or a new
    `sessionId` makes it 404 as soon as the new generation has a message
    (`src/gateway/session-transcript-read-kernel.ts:386-401`;
    `managed-image-attachments.ts:803-838`), and the hourly gc deletes it
    (`:446-458`; `src/gateway/server-maintenance.ts:84`); a session delete
    removes it within the hour; a record that never got a `messageId` dies
    after 15 minutes (`:118, 459-473`). the default reset policy is none
    (`src/config/sessions/reset-policy.ts:26`), so an outage of hours is
    usually harmless. copy bytes on first sight, for every non-archived
    thread whether or not anyone watches it (8.2).
28. **a playback transcode may not be ready**: the route answers 202
    `{"status": "preparing"}` (`src/gateway/managed-image-attachments.test.ts:540-558`):
    retry with backoff (8.4).
29. **`openclawDelivery.mediaUrls` is stripped from history**
    (`chat-display-projection.helpers.ts:36-55`): media comes only from
    content blocks and media facts.
30. **pairing for less than all five scopes** turns sends off without
    admin (3.3 step 7) and leaves boxbox blind to some approvals; widening
    later needs a new approval (3.4).
31. **compact roster rows omit the thinking levels** (compact rows drop
    `thinkingLevels`, `thinkingOptions`, `thinkingDefault`; facts in
    `src/gateway/session-utils-row.ts:534-540`). the reasoning capability
    reads them from full rows: `session.message` and keyed
    `sessions.changed` row snapshots when they carry them, and one
    `sessions.list {agentId, limit: 1}` full read per agent per connect.
32. **the same idempotency key with different content** is a terminal
    `chat-request-conflict` (`src/gateway/server-methods/chat-send-pre-admission.ts:178-185`):
    client ids are minted per send and never reused for other content.

## 7. sends and verbs

every verb answers its client with the gateway's own outcome (AGENTS.md, telemetry:
`ok` comes from the echo). the client routes, one per verb under
`/api/agents/{agent}/...`, are `docs/agents.md`'s; this section says what
each does on the gateway. a verb an agent lacks the capability for answers
422 `{error: "unsupported", capability}` (`docs/agents.md`).

### 7.1 send

`chat.send {sessionKey, agentId, sessionId, expectedLeafEntryId, message,
idempotencyKey, queueMode: "followup", suppressCommandInterpretation:
true, replyToId?, attachments?}` (`logs-chat.ts:312-350`). a send needs
`operator.admin` because of the suppression flag (3.3 step 7); without it
the send capability is false and nothing is sent.

- **before sending:** the client's `Send.generation` must equal the
  thread's `generation` (`docs/agents.md`; for openclaw the session's
  `sessionId`, hashed). a mismatch answers 409 `generation-changed` ("the
  conversation changed; review and resend") and nothing reaches the
  gateway. a thread whose row is archived is un-archived first (5.7).
- **`sessionId` alone does not pin the session.** when the key exists the
  gateway uses the entry's own sessionId (`backingSessionId =
  entry?.sessionId ?? requestedSessionId`,
  `src/gateway/server-methods/chat-send-session.ts:162-163`), and "changed
  while starting work. Retry." only compares the entry at load time with
  the latest one (`chat-send-admission.ts:295-297`). the fence is
  **`expectedLeafEntryId`**, always sent with `sessionId`: the thread's
  last known `activeLeafEntryId` (from the row, `sessions-row.ts:173`, or
  a delta answer, `session-accessor.sqlite-history-query.ts:291, 327`;
  `null` for an empty session). with a `sessionId` supplied, a leaf that
  moved forward on the same path still matches ("ancestor"); a rewind or
  branch switch fails with `active-leaf-changed`
  (`src/gateway/server-methods/chat-send-active-leaf.ts:4, 27-40`;
  `chat-send-admission.ts:287-290`), which boxbox answers as 409
  `generation-changed`. `/new` and `/reset` keep both the `sessionId` and
  the generation (`session-reset-service.ts:1132`), so a send composed
  before a `/new` lands after it; neither field can detect that, and the
  reset marker shows the person where it landed.
- **`idempotencyKey`** is the client's `clientID` for the send (the
  composer's outbox id), so a client retry of the same send carries the
  same key. it is also the run id
  (`src/gateway/server-methods/chat-send-session.ts:103`). the gateway's
  in-memory dedupe holds keys 5 minutes, about 1000 of them, and loses them
  on restart (`server-constants.ts:16-17`;
  `server-maintenance.ts:395-422`).
- **durable custody.** for a send to an existing session that is not a
  slash command or a goal operation, the gateway stages the input durably
  **before** it acks (`src/gateway/server-methods/chat-send-handler.ts:306-354`);
  boxbox's sends qualify (external, displayed, suppressed: `:306-312`).
  re-staging the same key finds the row: different content is a conflict,
  a consumed row answers `{runId, status: "ok"}` cached (`:343-351`). but
  when an ordinary followup input is promoted into the transcript its
  custody row is **deleted**; only collected inputs keep a
  `consumed_event_id`
  (`src/config/sessions/session-accessor.sqlite-pending-inputs.ts:646-672`).
  so for boxbox's sends `consumed` almost never comes back: the normal
  success proof is the user row itself.
- **acks:** `started` (not proof of a transcript row, doc
  `rpc-session-control.md:62`), `in_flight`, `ok`, or an aborted payload.
  boxbox answers the client 202 `{state: "accepted"}` on any of them and
  shows the message as sent once its user row arrives (a row whose
  `__openclaw.idempotencyKey` is the key or `<key>:user`). a timeout or a
  socket loss before the ack answers 202 `{state: "checking"}`, and the
  thread's `sends` carries `{clientID, state: "checking", at}` while
  boxbox reads receipts.
- **receipts, before any resend.** on a timeout, a socket loss or a
  restart, boxbox reads, on the next connection and before any new send
  on that thread, `chat.history {sessionKey, agentId, limit: 1000,
  maxBytes: 6 MiB, inputRunIds: [up to 50 open keys]}`, and while a
  receipt is `pending` but its item is not on the page, follows
  `pendingInputs.nextBefore` with `chat.history {sessionKey, agentId,
  limit: 20, pendingBefore, inputRunIds}`, as the reference client does
  (`ui/src/pages/chat/chat-outbox-receipts.ts:186-230`). it decides **in
  this order**, per key (`logs-chat.ts:68-102`;
  `chat-outbox-receipts.ts:48-55, 109-121, 289-325`):
  1. receipt `consumed`: done; `consumedByEventId` is the user row.
  2. a row in `messages` whose `__openclaw.idempotencyKey` is the key or
     `<key>:user` (`ui/src/lib/chat/history-message-identity.ts:25-49`):
     done; that row is the user row.
  3. receipt `pending` with `cancelled: true`: `sends` state `cancelled`,
     "cancelled on the gateway"; never resend.
  4. receipt `pending` with `queued: true`: accepted and waiting behind the
     running turn; it shows in the thread's queue; never resend.
  5. receipt `pending`, the `pendingInputs` item for the key in state
     `"interrupted"`, `sessionInfo.hasActiveRun !== true` and
     `sessionInfo.status` neither `running` nor `queued`: resend the
     **identical bytes** with the same key (custody re-admits it, or the
     dedupe answers `in_flight` or cached,
     `chat-send-pre-admission.ts:278-310`). an interrupted row while the
     session runs may be owned by restart recovery, and a re-stage of an
     admitted input throws "already admitted"
     (`session-accessor.pending-inputs.ts:259-288`), so:
  6. the session running or queued: wait for the run to end and read again.
  7. **everything else, absent included: `uncertain`, never an automatic
     resend.** the receipt table never authorizes a replay ("these durable
     correlations never authorize replay",
     `session-accessor.sqlite-pending-input-receipts.ts:19`), and a resend
     after the 5-minute dedupe would find the committed row as `queued`
     and likely run a second turn (`session-accessor.pending-inputs.ts:391-423`;
     the handler short-circuits only on consumed, `chat-send-handler.ts:341-354`).
- **uncertain** means boxbox cannot prove the message landed exactly once.
  `sends` carries `{clientID, state: "uncertain", at}`; the client shows
  the message as not confirmed, and the person chooses to send it again,
  which is a new send with a new `clientID`. the reference client does the
  same: "an absent receipt is still an uncertain send"
  (`chat-outbox-receipts.ts:109-110`). the server keeps no outbox of its
  own: open keys live in memory, at most 32 per thread and 256 per
  connection, each gone 30 minutes after `at` or when its user row
  arrives; a client retry of a `checking` send with the same `clientID` is
  reconciled first, never sent blind.
- **ordering:** at most one unacked send per session; send n+1 after n is
  acked. different sessions in parallel within section 10.
- **slash commands** are not offered to openclaw agents (capability
  `commands` false); text starting with `/` is sent as text (hole 24).
- **reminders and cron jobs still work** from a suppressed send, as on
  whatsapp: see section 13 and `openclaw_reminder` (section 12).

### 7.2 queue, never steer

openclaw's queue modes are `steer`, `followup`, `collect` and `interrupt`
(`logs-chat.ts:276`): steer injects into the running turn, followup runs
after it, collect coalesces, interrupt aborts the running turn and starts
the new message (doc `queue-steering.md:64-69`). boxbox always sends
`queueMode: "followup"`, so a message sent during a turn waits behind it
(capability `queue` true, `steer` false). `sessions.steer` is never called:
it now sends with `queueMode: "interrupt"`, an abort and restart
(`src/gateway/server-methods/sessions-messaging.ts:108-111`). a queued
input shows in `pendingInputs` on deltas (`logs-chat.ts:69-84`), which
boxbox surfaces as the thread's queue.

### 7.3 abort

`chat.abort {sessionKey, agentId, runId?}` (`logs-chat.ts:353-359`), with
the running `runId` from the row or live events. boxbox marks the abort as
the person's own action first, as it does for cmx2, so no push follows.
never `discardPendingInput` (queued messages stay queued).

### 7.4 new thread

`sessions.create {agentId, idempotencyKey: <client's new-thread id>, key:
"dashboard:<client's new-thread id>", model?, thinkingLevel?}`
(`packages/gateway-protocol/src/schema/sessions-create.ts:16-90`; the
fields boxbox may send are section 4's), **then** the first message with
`chat.send`. the gateway turns the key into
`agent:<agentId>:dashboard:<id>` (`src/gateway/session-create-key.ts:32-43`;
`src/routing/session-key.ts:118-137`), the same shape it mints itself
without a key (`session-create-key.ts:24-30`), so the thread classifies as
`dashboard` like one the control ui started. why a key: `idempotencyKey`
alone is a 5-minute in-memory map over identical params, lost on restart,
released when a create fails
(`src/gateway/server-methods/session-create-idempotency.ts:59-188`;
`sessions-create.ts:14`), so a lost answer across a restart or after 5
minutes would make an orphan session. "creates or adopts a session"
(`sessions-create.ts:16`): a retry with the same deterministic key adopts
the session the first call made, for good. the dev gateway test pins that
the adopt path keeps the first create's model and thinking level.
creating first gives the first message durable custody (7.1). the new
thread has no place (capability `places` false, `threads` true).

### 7.5 model and thinking

- the catalog: `models.list` (a preparation request), once per connect and
  on `models.snapshot`. the model picker shows it.
- set: `sessions.patch {key, agentId, expectedSessionId, model}` or
  `{..., thinkingLevel}` (`sessions-patch.ts:53, 82, 96-100`); `null`
  returns to the default. `expectedSessionId` makes a patch against a
  replaced session fail instead of landing on its successor.
- the reasoning chip is `{word: "thinking", levels}` from the row's
  `thinkingLevels` (hole 31). the level ids include `off, minimal, low,
  medium, high, xhigh, adaptive, max, ultra`
  (`src/auto-reply/thinking.shared.ts:13-24`); the row says which apply.
- `chat.send.thinking`, a one-turn override, is never sent (section 4).
  a `Send` that carries `model` or `effort` different from the session's
  is applied as a `sessions.patch` first (as above), and the send follows
  once the patch answers; the level is the thread's from that message on
  (`docs/composer.md`). a failed patch fails the send with the gateway's
  words and nothing is sent.

### 7.6 read state

`sessions.patch {key, agentId, expectedSessionId, unread: false}` when the
person reads a thread on any device ("false records the session as read",
`sessions-patch.ts:49-51`), and `{key, agentId, expectedSessionId, unread:
true}` for mark unread. `expectedSessionId` is optional on read patches
(`src/gateway/sessions-patch.ts:193-199` requires it only for lifecycle
patches) but always sent, so a read mark against a replaced session fails
instead of landing on its successor
(`src/gateway/server-methods/sessions-patch-expectations.ts:63-64`). an
**automatic** read (the thread was on stage on a looking device) also
carries `expectedMarkedUnreadAt`: the row's `markedUnreadAt` as boxbox
last saw it, or `null` for none (`sessions-patch.ts:11-16, 111`;
`sessions-row.ts:164`). the gateway applies it only when the marker still
matches (`src/gateway/server-methods/session-unread-ack.ts:53-66`), so an
automatic read never clears a "mark unread" the person made on another
device meanwhile; it is legal only on a patch whose one mutation is
`unread: false` (`:17-24, 40-50`), which boxbox's read patch is. a
person's explicit "mark read" omits it. boxbox's own read marks stay the
source for its surfaces; the patch keeps openclaw's control ui and phone
apps in step. debounced to one patch per thread per 10 s.

### 7.7 archive

`sessions.patch {key, agentId, expectedSessionId, archived: true}` (or
`false`). `expectedSessionId` is **required**: a lifecycle patch without
it is rejected ("expectedSessionId required for session lifecycle patch",
`src/gateway/sessions-patch.ts:193-199`). the answer is the gateway's; the
row's `archived` and `archivedAt` confirm it (5.7). marked as the person's
own action first. a send into an archived thread un-archives it first
(5.7, 7.1).

### 7.8 delete, reset, compact, rewind

not offered (capability `compact` false; no delete verb). they are outside
the allowlist. when they happen elsewhere boxbox follows them (5.6, 6.9).

### 7.9 approval resolve

`approval.resolve` with **exactly** `{id, kind, decision}`
(`approvals.ts:301-310`):

- `kind` is the snapshot's `presentation.kind`: `exec`, `plugin` or
  `system-agent` (`approvals.ts:16-20, 139-187`);
- `decision` is one of the snapshot's `presentation.allowedDecisions`
  (`allow-once`, `allow-always`, `deny`; deny always present,
  `approvals.ts:124-131`; system-agent approvals allow only `allow-once`
  and `deny`, `:133-136`), checked by boxbox before sending;
- never `reviewer` or `grantExpiresInDays`.

a wrong kind, a decision not allowed, or any invalid field **denies the
approval** (hole 23), so the request is built only from the generated
struct with those three fields, and a unit test serializes it and compares
the key set. the client maps allow once, always and reject to the three
decisions; "always" is labelled as a lasting grant (9.3).

**who won is `resolver`, not `applied`.** once the record is terminal,
`approval.resolve` answers `{applied: false, approval}` before any
decision logic (`approval.ts:353-365`); `applied` is true only for the
call that resolved it (`:166`). so a timed-out answer whose first write
won comes back `applied: false` on its retry. boxbox reads the terminal
snapshot's `resolver` (`approval.ts:81-88`): `{kind: "device", id: <boxbox's
device id>}` is boxbox's own answer whatever `applied` says, and the ask
settles with `by: {kind: "device", device: <the boxbox device that
answered>}`. a retry is safe: the terminal check precedes
`forceMalformedDeny` and the store's compare-and-set keeps the first
verdict (`approval.ts:353` before `:379`;
`src/gateway/operator-approval-store.types.ts:91-95`), so a retry can never
become a second decision or a deny.

- **at most one `approval.resolve` in flight per approval id**, retried on
  a timeout with the identical `{id, kind, decision}`.
- every boxbox client answers through boxbox's one gateway device, so the
  gateway cannot tell them apart. the first client answer to reach the
  source is the one sent; a later client answer to the same ask never goes
  to the gateway: it gets the ask's outcome, with "answered on your other
  device" when the decision differs.
- the four resolver kinds map to `ask.settled.by`: `device` (boxbox's, or
  another operator device: "answered on another device"), `channel` (any
  chat channel, `custody.resolverId`, `approval.ts:367-369`: "answered on
  <channel>"), `runtime` (a device-less client or auto-review,
  `src/gateway/exec-approval-manager.ts:592-604`), `system` (expiry, no
  route, gateway restart, run abort,
  `operator-approval-store.transitions.ts:313`; `outcome` is `expired` or
  `cancelled` with `reason`).

### 7.10 question answer

`question.resolve {id, answers: {answers: {<questionId>: [string]}},
resolutionId: <client's answer id>}` (`questions.ts:97-99, 158-173`), with
each question's `questionId` from the record (`questions.ts:8, 68-85`).
never `resolvedBy`, `cancel: true` or `secretStoreAllowedHosts`.

- **one resolve answers every question in the record**: a missing one
  fails `QUESTION_INVALID_ANSWER` unless it `allowEmpty`
  (`src/gateway/question-manager.ts:521-534`); at most one value unless
  `multiSelect` (`:546-548`); each value is the option's `value ?? label`
  unless `isOther` (`:556-568`). the client gathers every answer before
  boxbox sends.
- **`resolutionId` does not make a retry idempotent.** a resolve of any
  entry that is not pending throws `QUESTION_ALREADY_TERMINAL` whatever
  the id (`question-manager.ts:352, 493-506`); the id is only stored and
  handed to `question.waitAnswer` callers (`:97-106`), and `question.get`
  never returns it (`src/gateway/question-manager.test.ts:282-283`).
  boxbox still sends it (it serves agent-side waiters) and claims nothing
  from it.
- **after a timeout or `QUESTION_ALREADY_TERMINAL`**, call `question.get`
  at once (records live 15 s after a terminal state, `:28, 628-640`), never
  after a backoff:
  - `answered` with answers equal to what boxbox sent, compared on the
    canonical `value ?? label`: boxbox's answer won;
  - different answers: another surface won ("answered elsewhere");
  - still `pending` (another surface's store-bound answer is committing,
    `:493-503`): `question.get` again after 1 s, up to 15 s;
  - not found: `outcome: "unknown"`.
  never resend once a resolve may have landed; the gateway itself says
  "do not resubmit this answer" when a write's outcome is unknown
  (`:496-500`). at most one resolve in flight per question id.
- answering locks 5 s before `expiresAtMs`.
- **answered on the gateway only:** `isSecret`, a `secretStore` binding, a
  `presentation: "form"`, or a resource. `isSecret` always implies a write
  into the team secret store under boxbox's admin identity
  (`src/gateway/question-validation.ts:57-67`;
  `src/gateway/server-methods/question.ts:533-587`), so such a question is
  shown as "answer this on the gateway"; boxbox does not carry secrets.

### 7.11 reactions

- set: `session.reactions.set {sessionKey, agentId, messageId, emoji,
  remove?}`, `emoji` one grapheme
  (`packages/gateway-protocol/src/schema/sessions-reactions.ts:7-12,
  45-50`). `messageId` is the row's `__openclaw.id`. the answer carries the
  row's reaction summaries and a `mirror {status: delivered | failed |
  skipped, reason?}` (`:40-43, 54-58`), which boxbox returns to the client.
- **a reaction on a channel row is visible on that channel as the bot's
  reaction.** on a non-assistant row whose `__openclaw.transport` has
  `{channel, conversationRef, messageId}`, openclaw mirrors the reaction to
  that channel message; an assistant row is never mirrored
  (`src/gateway/server-methods/sessions-reactions.ts:54-88, 383-395`). in a
  group session the user rows are other people's messages, so a reaction
  there would put the bot's emoji on a stranger's message. so: boxbox
  offers reactions on a row with `__openclaw.transport` **only in direct
  sessions** (classification `main` or `direct`, 9.1), and the picker
  says "also reacts on <channel>" (the row's `transport.channel`). in a
  group, channel or thread session, rows with a transport are not
  reactable; assistant rows and rows with no transport are reactable
  everywhere. a `mirror.status` of `failed` shows on the client as "did
  not reach <channel>".
- read: `session.reactions.list {sessionKey, agentId}` once when a thread
  is opened (`:60-62`), since history rows do not carry reactions.
- live: `session.reaction {sessionKey, agentId, sessionId, messageId, emoji,
  action, actor, reactions}` (`:64-73`) goes to every connected client with
  read scope, unsubscribed and not dropped when slow; boxbox turns it into
  a `reactions` change when the thread is held, and ignores it otherwise.
- openclaw queues a system event worded "Control UI reaction ..." so the
  agent sees the reaction on its next turn (`sessions-reactions.ts:358-376`).

### 7.12 quote reply

`chat.send.replyToId` is "the transcript id of the message this send
replies to" (`logs-chat.ts:333-335`), resolved by a by-id transcript read
that also searches the reset archive
(`src/gateway/server-methods/chat-send-reply-context.ts:85-108`). that id
is the row's `__openclaw.id`, the same id boxbox encodes into its message
id (`m` + base64url, `docs/agents.md`), so boxbox decodes the quoted
message id back and sends it. the user row keeps `__openclaw.replyToId` and
`__openclaw.replyToPreview {text, senderLabel}` (text at most 2000
characters, label 200, `src/sessions/user-turn-transcript.metadata.ts:61-94`),
which is how boxbox draws the quote on a reload. the dev gateway test pins
that `__openclaw.id` on a tail row resolves as `replyToId` and as a
reaction `messageId`.

## 8. media

### 8.1 sending: inline base64 on `chat.send`

- attachments are `{mimeType, fileName, content, durationMs?, width?,
  height?}` with `content` base64 (bare or a data url)
  (`logs-chat.ts:250-267`; `src/gateway/chat-attachments.ts:275-290`).
  bytes travel inline; there is no upload step.
- caps come from `hello-ok.policy.attachments`: `maxBytes` per attachment
  (`agents.defaults.mediaMaxMb`, default 20 mb) and `maxImageBytes`
  (`min(maxBytes, 6 mb)`) (`frames.ts:166-171`; doc `handshake.md:103-111`),
  re-read on every reconnect. capability `attachments.maxBytes` is
  `min(policy.attachments.maxBytes, what fits)`: the whole encoded frame
  must fit `policy.maxPayload` (hole 26), so boxbox serializes the request
  and refuses it before sending with "this file is too large for vm-b
  (limit n mb)".
- a voice note from boxbox goes as recorded, with `durationMs`, and boxbox
  does no transcode (`docs/agents.md`): `audio/mp4` (m4a) from native
  clients, else `audio/webm` or `audio/ogg` (opus) from the web. openclaw
  runs the same media understanding on it as on a whatsapp voice note,
  which is ogg/opus itself, so the agent hears it
  (`src/gateway/server-methods/chat-send-user-turn.ts:287-291`); the
  gateway's mime table knows all three (`packages/media-core/src/mime.ts:24,
  34`), and `openclaw_attachments` pins that each of the three is heard
  (section 12). the transcript openclaw makes is not stored on the user row
  (the row keeps the raw text only, `src/gateway/chat-user-turn-recorder.ts:70-83`,
  and only a `transcribed` flag, `src/media-understanding/audio-preflight.ts:70-74`),
  so the transcript a person sees under their own voice note is boxbox's
  sidecar from the device (`audio.transcript`, `docs/agents.md`).
- images may go to the model inline; everything else is offloaded to the
  gateway's `media/inbound` and the prompt gets a marker
  (`chat-attachments.ts:364-452`).

### 8.2 fetching: what boxbox reads and how

media reaches boxbox in three shapes:

1. **managed content blocks** on assistant rows: `image`, `audio`, `video`
   `{type, artifactId, url: "/api/chat/media/outgoing/<sk>/<id>/full",
   mimeType, sizeBytes, alt | fileName, width?, height?, openUrl?,
   playback?}` and documents as `{type: "attachment", attachment:
   {artifactId, url, kind: "document", label, mimeType, sizeBytes}}`
   (`src/gateway/managed-image-attachments.ts:544-577`, `openUrl` and
   `playback` at `:571, 574`); `isVoiceNote: true` is added afterwards to
   audio from `audioAsVoice` replies
   (`src/gateway/server-methods/chat-assistant-content.ts:275-281`). generated images,
   music and files, and tts voice replies, all arrive this way.
   **fetch:** `artifacts.download {sessionKey, agentId, artifactId,
   transport: "http"}` (`packages/gateway-protocol/src/schema/artifacts.ts:66-81`)
   returns a url with a 5-minute `mediaTicket`
   (`src/gateway/server-methods/artifacts.ts:468-489`), then one `GET` of
   that url (adding `&playback=1` for audio, 8.4). tickets avoid needing
   owner rights on the bearer (`managed-image-attachments.ts:1445-1447`).
   inline-data blocks come back as base64 in the answer (`artifacts.ts:490-517`);
   other blocks get a connection-bound grant url, 5 minutes, at most 128
   per connection (`src/gateway/artifact-download-grants.ts:10-104`).
2. **media facts** on user rows: `__openclaw.media[] = {url | path,
   contentType, kind, fileName, sizeBytes, durationMs, transcribed?}`, for
   voice notes and files the person sent from boxbox or over whatsapp
   (`chat-attachments.ts:209-231`); inbound host paths are rewritten to
   `media://inbound/<id>` in history
   (`src/gateway/chat-display-projection.sanitize.ts:108-120`), and
   `transcribed: true` comes from `src/media-understanding/audio-preflight.ts:70-74`,
   kept by `src/sessions/user-turn-transcript.message.ts:80`.
   **fetch:** `GET /__openclaw__/assistant-media?source=<url or
   path>&sessionKey=<k>&agentId=<a>` with the device token as bearer
   (`src/gateway/control-ui.ts:428-594`; the route's scope is
   `assistant.media.get`, operator.read, `core-descriptors.ts:340`), adding
   `&playback=1` for audio.
3. **failure blocks** (`attachment_error`,
   `src/gateway/chat-assistant-content.ts:190-203`): a `file` part with
   media `missing` and the gateway's words.

**copy on first sight.** the first time boxbox sees a row with media in
any non-archived thread, watched or not (a tail, a delta, a hydration or a
live `session.message`; every such row is journaled, 5.2), it queues a
fetch into the
content-addressed media store (`docs/agents.md` owns the store, its route
`GET /api/media/{id}`, its caps and eviction). the part goes out with
`media {id: null, state: "pending"}` and a `part` change follows with
`ready` and the sha256 id. bytes are copied once because urls expire in 5
minutes and managed records die once their row leaves the current
generation, by a reset or a new `sessionId` (compaction keeps them, hole
27), and inbound files die if the gateway ever sets
`attachments.ttlHours` (unset by default, `server-maintenance.ts:544-549`).
fetches are bounded (section 10) and never block the sync. a fetch that
finds the queue full is deferred to the row's next sight, never marked
`missing`.

### 8.3 the spoken text

an assistant row whose reply was spoken carries
`openclawDelivery.tts {tagged, text?, directives?}` and
`openclawDelivery.audioAsVoice`, with the directives stripped from the
persisted text (`src/config/sessions/transcript-assistant-delivery.ts:45-56,
94-110`). history passes `openclawDelivery` through unchanged except
`mediaUrls` (hole 29). boxbox puts `tts.text` (or the row's visible text
when `tts.text` is absent) on the audio part as `spoken`, so a client can
show "what the agent said" under the voice reply. audio blocks with
`isVoiceNote: true` get flavour `voice`.

### 8.4 playback for ios

- whatsapp voice notes are ogg/opus and tts output may be ogg or wav;
  ios's player needs m4a. both routes transcode on `playback=1`: the
  assistant-media route (`control-ui.ts:582-594`) and the managed outgoing
  route (`managed-image-attachments.ts:1546-1579`), through ffmpeg to aac in
  an m4a container served as `audio/mp4`
  (`src/media/playback-transcode.ts:395-434, 549-610`), cached on the
  gateway for 7 days or 512 mb. native types pass through, and a failed
  transcode falls back to the original bytes.
- a block's url never carries the query; boxbox appends `playback=1`
  itself. a 202 `{"status": "preparing"}` (hole 28) is retried at 1, 2, 4
  and 8 s, then once a minute for 10 minutes.
- boxbox stores the m4a it fetched; it never fetches both forms.

### 8.5 retries, and when bytes are gone

- a fetch is retried with backoff (1 s to 5 minutes, jittered) up to 6
  times while its row is held; an expired ticket gets a fresh
  `artifacts.download`. a gateway restart invalidates every ticket (the
  ticket hmac secret is per process, `src/gateway/managed-image-tickets.ts:11`)
  and every grant (they die with the connection,
  `src/gateway/artifact-download-grants.ts:70-79`), so after a restart
  fetches start again from `artifacts.download`.
- 404, or a block whose record is gone (a managed record must still be
  referenced by a row of the current generation,
  `managed-image-attachments.ts:885-935`), or an assistant-media source
  outside the agent's roots: the part becomes `media {state: "missing"}`
  and the client shows "this file is no longer on vm-b". after the 6
  retries the part is `missing` too, but **`missing` stays retryable**:
  the next sight of the row (a thread open, a tail, a hydration) queues one
  more fetch, since bytes usually survive as long as the row is current.
  queue overflow defers to the next sight and never sets `missing`.
- bytes already copied never go missing because the gateway lost them;
  only boxbox's own eviction removes them (410 on the media route).

## 9. mapping openclaw to boxbox's neutral shapes

names are `docs/agents.md`'s (`agent`, `thread`, `message`, `part`, `ask`,
capability keys).

### 9.1 agents, connections, threads

| openclaw | boxbox |
|---|---|
| one gateway, one `[[openclaw]]` entry | one connection |
| an `agents.entries` agent (from `snapshot.health.agents`) | one agent: key `<connection>-<slug(agentId)>` or pinned, label `{name, source: "openclaw", machine}`, kind `assistant`, mark `round`, palette from the file (the first assistant slot is `coral`) |
| a session row (`agent:<agentId>:<rest>`) | one thread, id `oc_` + 24 base32 chars of the sha256 in `docs/agents.md` (session keys hold `:` and so cannot be thread ids) |
| row `label`, `displayName`, `derivedTitle` | thread title, in that order |
| row `status`, `lastRunError` (`sessions-row.ts:167-168`) | `activity`: `busy` while running, `idle`, or `{state: "failed", message: <lastRunError>}` when the last run ended in an error |
| the session's `sessionId` | `generation`: its sha256, base32, opaque to clients; unchanged by `/new` (5.6, 7.1) |
| the last committed row that wrote text for the person, or a raised ask | `said` (ms on the gateway's clock): set for every openclaw thread, so a quiet scheduled run moves `updated` and wakes nothing (`docs/home.md`, quieter runs) |
| open send keys boxbox could not confirm | `sends` (7.1) |
| row `parentSessionKey`, `childSessions` | parent and child threads (capability `subagents`) |
| row `archived` | archived thread |

**session kinds**, from `classification` (an open string, first match wins,
`src/gateway/session-classification.ts:98-125`), `isMain`, `isBackground`
(`session-classification.ts:22-31, 135`) and `createdVia` (`sessions-row.ts:217-228`):

| kind (classification) | key shape | boxbox thread |
|---|---|---|
| main (`main`) | `agent:<id>:main`; whatsapp direct messages land here with the default dm scope | the agent's main thread, pinned first on its card |
| a thread boxbox or the control ui started (`dashboard`) | `agent:<id>:dashboard:<uuid>` | an ordinary thread |
| a channel peer or group (`direct`, `group`, `channel`) | `agent:<id>:<channel>:direct:<peer>` and so on | an ordinary thread, origin from its rows |
| a channel thread or topic (`thread`) | `<base>:thread:<id>`, telegram `:topic:<id>` | an ordinary thread whose parent is the base session's thread when that is held |
| a cron run (`cron`, background) | `agent:<id>:cron:<job>:run:<runId>` | a thread with `origin {kind: "scheduled", name}`. a run that said something (its `said` moved) is gathered into its assistant's one runs window (`agent.runs`, order key `<agent>:runs`, `docs/home.md`, quieter runs); a silent one is in history only; one that raised an ask gets a window like any other. gone after 24 h when openclaw deletes it |
| an isolated heartbeat run (`heartbeat`, background) | `<main key>:heartbeat` | as cron, `name` `heartbeat`; a shared heartbeat runs inside the main session and shows there as scheduled turns |
| a subagent (`subagent`, background) | `agent:<id>:subagent:<uuid>` | a child thread, never a window of its own (as cmx2 subagents) |
| anything else (`system`, `hook`, `custom`, ...) | | an ordinary thread with no window |

### 9.2 messages and parts

a history row is a `message` (id `m` + base64url of `__openclaw.id`, or of
`messageId` on `session.message` and delta envelopes, 5.1). its
content blocks become parts (`<message id>_<index>`):

| openclaw | part |
|---|---|
| assistant `text` block | `text` |
| `thinking` block | `reasoning` |
| assistant tool call block, with its `toolResult` row (rows of role `toolResult` carry the result and the call id) | one `tool` part, `state.status` from the result, `family` from the tool name (`exec` is `shell`, `read` is `read`, `web_search` is `web`, `sessions_spawn` is `spawn`, `ask_user` is `ask`, and so on; unknown is `other`); a result row is folded into its call and never drawn alone |
| live `session.tool` (cap `tool-events`) | updates to that `tool` part while running |
| a delta's `activity` items (`logs-chat.ts:116-150`) | the running step group's titles and status |
| user `text` | `text` |
| image block or image media fact | `image`, flavour `attached` (yours) or `generated` (the agent's tools) |
| audio block or audio media fact | `audio`, flavour `voice` for voice notes and `isVoiceNote`, `spoken` from 8.3, `durationMs` |
| video, document attachment, file media fact | `file` |
| `attachment_error` | `file`, media `missing`, a `notice` |
| a reset boundary or compaction event | `marker` (`reset`) or `compaction` |
| a row marked `truncated` | its text part (the longest copy any path delivered, 5.2), plus a `notice`: "cut here; the rest is on the gateway" for `display-cap`, "too large to show here; open it on the gateway" for an `oversized` placeholder |
| the row's `messageSeq` (`session.message`, delta envelope) or `__openclaw.seq` (tail) | the message's `position` (5.4) |
| an unknown block type | the fallback row (never a crash or a blank) |

tool steps fold into step groups the way cmx2's do: consecutive tool parts
between prose form one group (`docs/thread.md`), so the agent's words read
as prose and its steps fold.

the transcript block tags are decoded leniently and pinned by fixtures
(2.3); the first dev gateway task records one of each from a real run.

### 9.3 asks

| openclaw | ask |
|---|---|
| a pending approval (`exec`, `plugin`, `system-agent`) | a permission ask on the thread of `request.sessionKey` + `request.agentId` from the requested event or the list entry (5.9), never from `approval.get`; options from `allowedDecisions` (`once`, `always`, `reject`), `always` with `lasting: true` and labelled "allow always (a lasting grant)", because allow-always on exec mints a durable standing grant (`approvals.ts:91-101`; `approval.ts:427-435`); `title` from `presentation` (`commandText` for exec, `title` and `description` for plugin and system-agent); `warning` from exec's `warningText`, `risk: "high"` from a plugin's high `severity`, `detail` (collapsed) from its `detail`, and `scope` as plain lines from `presentation.scope` ("to 3 recipients", "pay 20 usd to <target>", "post publicly", "always allow <command> in <automation>") (`approvals.ts:59-112, 139-181`); deadline `expiresAtMs` |
| a terminal snapshot | `ask.settled {outcome, option?, reason?, by?, at}`: `answered` with `option` the decision and `by` from `resolver` (7.9: `device` with `device` set when it was boxbox, `channel` with `name` the channel, `runtime`, `system`); `expired`; `cancelled` with `reason` (`gateway-restart`, `no-approval-route`, a run abort); `unknown` when `approval.get` finds nothing; `at` the snapshot's `resolvedAtMs` |
| a pending question | a question ask: up to 3 questions, each with `header`, `question`, `options`, `multiSelect`, free text when `isOther` or no options |
| `question.resolved` | `ask.settled {outcome: answered | expired | cancelled, by?, at}`; after a boxbox answer, `by.device` when the answers match what boxbox sent (7.10) |

needs are raised and served through the existing ledger (`fleet/needs.rs`),
so the wants-you tray, push and telemetry (`need.raised`, `need.served`)
treat them like cmx2's.

### 9.4 quotes, both ways

- **quoting from boxbox:** 7.12. the user row's `replyToPreview` gives
  `quote {message, sender, preview, glyph}` on reload, with `durationMs`
  when the quoted message is a voice note boxbox holds.
- **the agent quoting:** an assistant row with
  `openclawDelivery.replyToId` quotes that row, and `replyToCurrent` quotes
  the user message that started the turn
  (`transcript-assistant-delivery.ts:94-110`). boxbox resolves the id
  against the seen index or by an around-message read, and builds the
  quote from the target's text.
- **quotes made inside whatsapp** carry only the whatsapp stanza id in
  `__openclaw.transport.replyToId` (`src/auto-reply/reply/get-reply-run-execute.ts:288-311`).
  a quote of one of the person's own rows can be matched by
  `transport.messageId`; a quote of the agent's rows cannot (section 13).
  unmatched, the quote is `{message: null, preview: null}`, and the
  client draws "replied to a message on whatsapp" itself
  (`docs/agents.md`, quote).

### 9.5 reactions

`session.reactions.list` on open and `session.reaction` live become the
message's `reactions` (`by: "you"` for boxbox's device actor, `"agent"` for
the agent, else the actor's label).

### 9.6 origin

- a turn that arrived over a channel has a user row with
  `__openclaw.transport.channel` (for example `whatsapp`), set from the
  conversation identity, the originating channel or the provider
  (`get-reply-run-execute.ts:295-311`; kept on the row,
  `user-turn-transcript.metadata.ts:96`). boxbox sets that message's
  `origin {kind: "channel", name: "whatsapp"}`, and the assistant rows of
  the same turn inherit it. that is how "via whatsapp" is known: from the
  row, never from the session key.
- a cron or isolated heartbeat thread's messages get `origin {kind:
  "scheduled", name: <job label when known, else "heartbeat" for a
  heartbeat>}`, and the thread itself carries the same `origin`; a shared
  heartbeat turn in
  the main session is recognised by its input provenance
  (`packages/gateway-protocol/src/schema/primitives.ts:50-60`) and gets the
  same.
- boxbox's own sends and the agent's own turns have no origin.
- **sender:** a user row with `__openclaw.senderIsOwner: false` (a group
  chat member who is not the person) gets the message's `sender`, from
  `__openclaw.senderName`, else `senderUsername`, else `senderId`
  (`src/sessions/user-turn-transcript.metadata.ts:66-75`). the person's
  own rows (`senderIsOwner` true or absent) carry no `sender`.

### 9.7 capabilities of an openclaw agent

| capability | value |
|---|---|
| places, worktree, terminal, review, compact, steer, commands, files, shell, admin | false |
| queue | true (followup, 7.2) |
| model | true (`models.list`) |
| reasoning | `{word: "thinking", levels}` from the row (hole 31) |
| approvals, questions | true |
| attachments | `{kinds: ["image/*", "audio/*", "video/*", "application/pdf", "text/*"], maxBytes: min(hello-ok.policy.attachments.maxBytes (20 MiB by default), what fits maxPayload, 8.1), maxCount: 8}`; the count is boxbox's own limit, not the gateway's |
| voice | `{notes: true, replies: true}` |
| quotes, threads, archive, history, subagents, origins | true |
| reactions | true; on channel rows only in direct sessions (7.11) |
| spend | per agent: true when its sessions carry `estimatedCostUsd` (on the session row and `sessionInfo`; a transcript row carries only `usage.cost.total`, pinned by the recorded fixtures) |

a capability whose method is missing from `features.methods` goes false
(2.5); `mode = "watch"` makes every write capability false; a pairing
without `operator.admin` makes every capability that starts a turn false
(3.3 step 7).

## 10. load limits

boxbox must never be the reason the gateway is slow for the person's own
channels and apps. these are hard limits per connection, enforced by one
scheduler in the connection task, each with a `perf.openclaw.*` telemetry
row (AGENTS.md, memory and latency):

| item | limit |
|---|---|
| connections | 1 websocket |
| requests in flight | 4 in total; preparation-class (`sessions.subscribe`, `sessions.list`, `models.list`, approval-carrying subscribes) **1 at a time** (4 shared slots gateway-wide, `request-start.ts:50, 110-115`); never more than 8 queued (a self-limit well under the gateway's 16 control and 256 work slots per connection, `request-start.ts:30-44`); a verb that finds the queue full answers 503 `agent-busy` with `retry-after` |
| roster pages | `limit: 100`, compact, serial, at least 250 ms apart; a full re-list at most once a minute |
| deltas | at most 2 in flight, 10 a second; single-flight per session, 300 ms debounce |
| tails | 1 in flight; limit 50 to 1000, `maxBytes` 1 to 6 mib; cursorless sessions at most one per 5 s; the reset guard (6 a minute) |
| hydration | one read-through per thread at a time, shared by every client that asked; at most 2 a second per connection; served from the read cache when present and revalidated by one delta (5.5) |
| cold start | one session at a time, at most 2 a second, newest first; only sessions active in the last 30 days |
| backfill | only on a client's request; `limit: 200`, `maxBytes: 2 MiB`, at most 1 page a second |
| oversized-row fetches | `chat.message.get` only while allowlisted (section 4), once per row, at most 1 a second |
| safety sweep | every 10 minutes for recent or running sessions, every 60 s for watched ones; at most 1 delta a second in all |
| per-session subscriptions | at most 8; full only for on-stage threads; approval-carrying subscribes 1 in flight; subscribe and unsubscribe at most 2 a second |
| sends | one unacked per session; at most 4 sessions in parallel; at most 1 send a second per session; open send keys 32 per thread, 256 per connection, 30 minutes |
| approval and question lists | on connect and every 5 minutes; one `get` per raised ask at its deadline plus 5 s |
| `agents.list` | once per connect and when the health agent set changes |
| media fetches | 2 in flight per connection, 64 queued, 8 MiB a second, a 1 MiB copy buffer each (bytes stream to the store); overflow defers to the next sight, never `missing` |
| live text | 8 runs per connection, 256 KiB each; the oldest is dropped past either |
| buffered events before a session's bootstrap | 256 per session; past it the buffer is dropped and the session goes to `needs_tail` |
| seen index | 200 rows per thread, 2,000 threads per connection, lru (5.2) |
| read cache | `docs/agents.md`'s caps (per thread 200 rows or 2 MiB, 30 days, 256 MiB across connections) |
| retries | `retryAfterMs` is a floor; otherwise 1 s to 30 s exponential with full jitter; never retry a `checking` send or an answer without reconciling, never resend an `uncertain` one |
| archived sessions | never read unless a person opens one |
| the reader channel | 4096 frames or 16 MiB; shedding at half, stops reading when full (3.6, 5.8) |

## 11. the dev gateway (`just openclaw`)

the openclaw counterpart of `just cmx2`: a real gateway built from the
pinned commit, a scripted model, an isolated state dir, never an inherited
config or key. decision 22 holds here too: the model is scripted, the
gateway is real, and boxbox's integration never mocks the gateway.

### 11.1 the command

`just openclaw` runs `bun scripts/openclaw.ts`, which shares
`scripts/openclaw-pinned.ts` with the test harness so the two can never
start the gateway differently (as `scripts/pinned.ts` serves `just cmx2`
and `just probes`). flags: `--fresh` wipes the bench state, `--port <n>`
moves the gateway (the model takes n + 1, the speech stub n + 2),
`--pairing manual` turns off loopback auto-approval and binds the lan
address for the pairing test (11.6), `--archive-dashboard-after <duration>`
shortens `session.maintenance.archiveDashboardAfter` for the auto-archive
test (11.7), and `--build-only` builds and exits. `just openclaw-smoke`
runs `bench/openclaw-smoke.ts` against the running bench.

### 11.2 the source: a bare mirror, then `git archive`

1. the mirror is `~/.cache/boxbox/openclaw.git` (`OPENCLAW_MIRROR` overrides
   it). missing, it is created as a bare repo with `origin` at
   `https://github.com/openclaw/openclaw.git`; a mirror without the pinned
   commit fetches exactly that commit, `git fetch --depth=1 origin <commit>`
   (165 mib). not `git clone --mirror`: github hands a mirror clone every
   pull request's refs, past 10 gib (`docs/gotchas.md`, the openclaw dev
   gateway). nothing ever runs from a working tree, and
   no local openclaw checkout is ever used in its place.
2. `git archive --format=tar <commit>` from the mirror, unpacked into
   `.openclaw/<commit>/` (gitignored, beside `.cmx2/`), once.
3. install and build, once per commit, with the tree's own tools:
   - node must satisfy `engines.node`, `>=24.16.0 <25 || >=26.1.0`
     (`package.json:2379-2381`); the script checks `node --version` first and
     says what to install.
   - pnpm is the tree's `packageManager`, `pnpm@12.5.1+sha512...`
     (`package.json:2382`), run through `corepack` so the exact version is
     used (`npx --yes corepack@0.36.0 pnpm`, since node 25 and later ship
     no corepack). bun cannot install this workspace (doc
     `docs/install/bun.md:21-31`).
   - `pnpm install --frozen-lockfile`, then `pnpm build` (`package.json:1683`;
     the source install doc runs `pnpm install && pnpm build && pnpm
     ui:build`, `docs/install/index.md:158`; the control ui is disabled in
     the bench, so `ui:build` is skipped).
   - `pnpm protocol:gen` and the comparison with the vendored schema (2.2).
   - a `.built` stamp holding the commit, so a half-built tree is redone.
4. ffmpeg must be on the path (playback transcodes, 8.4); the script checks
   and says so.

### 11.3 ports

the gateway takes **4740 to 4748**, 4740 by default, with the scripted
model on the next port and the speech stub on the one after; a parallel
lane takes x0 to x7 of its own decade from **4700 to 4830s**, handed to it
with its cmx2 decade. never 4840 and up: that is cmx2's range, 4840 to
4998 with parallel lanes taking their own decades (`scripts/pinned.ts:23-33`;
`docs/gotchas.md`, parallel lanes and ports on a shared machine). the
script refuses any other port and refuses a port already listening. the
gateway is started with `--port` explicitly; `OPENCLAW_GATEWAY_PORT` is
blanked (`src/config/paths.ts:413-430` gives env precedence over config).
with the canvas host and browser control off (below), the gateway binds
only its own port.

### 11.4 the process

```
node .openclaw/<commit>/dist/index.js gateway run --port <P> --bind loopback --allow-unconfigured
```

(`dist/index.js` is the package `main`, `package.json:461`; the argv is
the one openclaw's own qa harness uses,
`extensions/qa-lab/src/gateway-child-setup.ts:327-335`). the environment is
an allowlist, as `daemonEnv` is for cmx2:

- `PATH`, `LANG`, `TMPDIR`; `HOME` and `OPENCLAW_HOME` =
  `.openclaw/bench/home` (`OPENCLAW_HOME` is read at
  `src/infra/home-dir.ts:26-35`); `OPENCLAW_STATE_DIR` =
  `.openclaw/bench/state` (`src/config/paths.ts:77`);
  `OPENCLAW_CONFIG_PATH` = `.openclaw/bench/openclaw.json`
  (`src/config/paths.ts:230`);
- `OPENCLAW_SKIP_CHANNELS=1`, `OPENCLAW_SKIP_PROVIDERS=1` (no channels;
  `src/gateway/server-startup-post-attach.ts:198`,
  `src/gateway/server-sidecar-startup-mode.ts:6-10`),
  `OPENCLAW_SKIP_GMAIL_WATCHER=1`, `OPENCLAW_SKIP_CANVAS_HOST=1`,
  `OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1`
  (`extensions/browser/src/plugin-service.ts:34`);
- `OPENCLAW_DISABLE_BONJOUR=1`, `OPENCLAW_NO_AUTO_UPDATE=1`,
  `OPENCLAW_NO_RESPAWN=1`;
- `OPENCLAW_GATEWAY_HOST_LIFELINE=stdin`: the gateway exits when the
  script's pipe closes (`src/cli/gateway-cli/host-lifeline.ts:24-32, 40`);
- **not** `VITEST`, `NODE_ENV=test` or the vitest pool ids, which change
  gateway behaviour; **not** `OPENCLAW_SKIP_CRON` (the bench needs a cron
  run for the scheduled origin; the fixture's job never fires on its own).
  `OPENCLAW_SKIP_STARTUP_MODEL_PREWARM` is not set: nothing in the tree
  reads it.

the script supervises like `scripts/cmx2.ts`: one process tree, each child
in its own process group, ctrl-c or sigterm stops all of them, one dying
stops the rest, and a gateway that exits cleanly after a restart request is
started again (an installed gateway's supervisor would). it waits for the
gateway by connecting with the bench token until `hello-ok`, prints
`server.version` and checks it equals the pin's `version`, and writes
`.openclaw/bench/gateway.json` (`{url, commit, pids}`).

### 11.5 the scripted model

the pinned tree's own `scripts/e2e/mock-openai-server.mjs`, run from the
export (`node .openclaw/<commit>/scripts/e2e/mock-openai-server.mjs`). it
speaks the openai responses api the gateway's provider code expects at
exactly this commit, which a boxbox reimplementation could only drift from.

- env: `MOCK_PORT=<P+1>`, `MOCK_BIND_HOST=127.0.0.1`,
  `MOCK_RESPONSE_CONTROL=.openclaw/bench/script.json` (re-read on every
  request), `MOCK_REQUEST_LOG=.openclaw/bench/model-requests.jsonl`
  (`scripts/e2e/mock-openai-server.mjs:20-43`).
- a script is `{responses: [entry...], default?, hold?}` consumed one entry
  per model request, or `{models: {<model id>: entry}}` routed by model;
  an entry is `{text}`, raw responses `{events}` (tool calls such as
  `exec`; `ask_user`, `automations` and every tool the model does not see
  by name go through `tool_call {id, args}`, the compact tool surface), `{fail: {mode: "drop"}}` or `{fail: {status}}`,
  with optional `chunkDelayMs`; top-level `hold: true` holds the response
  until the file is rewritten.
- boxbox's side is `bench/openclaw-script.ts`, in the style of
  `bench/model.ts`: named scenarios (`words N MS`, `tools`, `approval`,
  `question`, `image`, `voice`, `long N`, `hold`, `drop`) that write the
  control file, so a test says `script("approval")` and sends.
- **the speech stub.** the mock has no `/v1/audio/speech`, and tts replies
  need one. `bench/openclaw-speech.ts` answers it on `P+2` with a short
  ogg/opus clip it renders once with ffmpeg at start, so voice replies and
  the `playback=1` transcode are exercised with real bytes. the gateway's
  tts provider is the openai-compatible one
  (`src/tts/openai-compatible-speech-provider.ts`) pointed at it, with
  `messages.tts.auto = "tagged"`.

### 11.6 the fixture config

`.openclaw/bench/openclaw.json`, written on every start from
`scripts/openclaw-pinned.ts` (shape from `src/gateway/gateway-concurrent-streams.test.ts:480-531`
and `scripts/e2e/lib/fixtures/mock-openai-config.mjs:20-70`):

- `gateway: {mode: "local", port, auth: {mode: "token", token: <bench
  token>}, controlUi: {enabled: false}}`, plus
  `nodes.pairing.autoApproveLocal: false` under `--pairing manual`;
- `models: {mode: "replace", providers: {"mock-openai": {baseUrl:
  "http://127.0.0.1:<P+1>/v1", apiKey: "bench", api: "openai-responses",
  request: {allowPrivateNetwork: true}, models: [one free 128k model]}}}`,
  the model's params `transport: "sse"`;
- **two agents** in `agents.entries`: `main` (name "assistant", the
  default) and `helper` (name "helper"), each with its own workspace under
  `.openclaw/bench/work/<id>`; `skipBootstrap: true` and heartbeat off in
  `agents.defaults`. at 2026.10.1 the default is named the way `openclaw
  doctor --fix` writes it: `agents.ownership: "explicit"`,
  `agents.defaults.systemAgent.agentId: "main"` and `talk.agentId: "main"`
  (an entry's `default: true` fails start), with
  `agents.defaults.modelPolicy.allow` naming the model, and the model
  `reasoning: true` so thinking levels other than off apply;
- `tools.exec.mode: "ask"` and `host: "gateway"`, so a scripted `exec`
  raises an approval (it is denied at once unless a connected operator
  claims the `approvals` cap, 3.5);
- one cron job on `main`, disabled, run on demand by the harness: jobs live
  in the gateway's store, not the config, so `just openclaw` adds `bench
  scheduled` with `cron.add` once;
- `plugins.slots.memory: "none"`, `plugins.entries.openai.enabled: true`
  (the speech provider), `hooks.enabled: false`, the tts block above (root
  `tts`, not `messages.tts`: `{auto: "tagged", provider: "openai",
  providers: {openai: {baseUrl: <P+2>, apiKey, model, speakerVoice}}}`),
  `update.checkOnStart: false`, and `logging.file` in the bench (the
  default is `/tmp/openclaw/`, shared by every gateway on the machine).

the bench token is minted once into `.openclaw/bench/token` (mode 0600, the
same `mintPassword` as cmx2's bench) and never an inherited one. the script
adds an `[[openclaw]]` entry for the bench (`url = "ws://127.0.0.1:<P>"`,
`token_file` = that file) to the bench boxbox configs through
`writeBoxboxConfigs` in `scripts/pinned.ts`, so `just cmx2` and `just
openclaw` write the same two files through one function. (not yet: the
server's config refuses unknown sections until it reads `[[openclaw]]`;
`docs/open.md`.)

**pairing in the bench:** on loopback a `gateway-client`/`backend` client
with the shared token skips pairing altogether and gets no device token
(3.4), so `just dev` works at once on the shared-token path. the pairing
test needs the remote path: it starts a second bench gateway on a lane
port with `--bind lan` and `--pairing manual`
(`nodes.pairing.autoApproveLocal: false` turns off silent local approval,
`handshake-auth-helpers.ts:82-131`), connects boxbox to the machine's own
non-loopback address, and approves with `node .openclaw/<commit>/dist/index.js
devices approve <requestId>` under the same `OPENCLAW_STATE_DIR`
(`src/cli/devices-cli.ts:64`). that the gateway classes its own lan address
as remote is the first thing the first dev gateway task pins; if it does
not, the pairing test runs the gateway in a container with its own network
namespace instead. the lan bind is token-protected, test-only and stopped
by the test.

### 11.7 chaos switches

the harness (`bench/openclaw-chaos.ts` and the integration tests) drives
each through a **separate chaos client**: a raw websocket with the bench
token as `gateway-client`/`backend`, which loopback admits without a
device (`handshake-auth-helpers.ts:222-244`). the chaos client may call
anything (`sessions.compact`, `sessions.reset`, `cron.run`,
`approval.resolve`): the allowlist binds boxbox's server, not the harness.

| switch | how |
|---|---|
| drop the socket mid-turn | script `hold`, wait for the first `chat` delta, close boxbox's own socket (a debug-only server hook, compiled out of release), reconnect, release the hold |
| slow consumer | pause boxbox's reader (the same debug hook) while the script streams large deltas with `chunkDelayMs: 0` and a long transcript is read; assert recovery whether or not 1008 fires (50 mib is hard to reach), and cover the 1008 branch itself by injecting the close in the hook |
| restart mid-turn | script `hold`, `kill -9` the gateway pid, start it on the same state dir, release; the extra model call the resume makes is scripted |
| restart cleanly | `SIGUSR2` restarts in place (`src/cli/gateway-cli/run-loop.ts:1101-1107`) |
| compaction or rewrite | the chaos client calls `sessions.compact`, `sessions.reset` (or sends `/new` as text without suppression), and `sessions.rewind` (a new `sessionId`) |
| an approval resolved elsewhere | script `exec`, let boxbox raise the ask, resolve it from the chaos client, then answer from boxbox |
| a send across a restart | close the socket the instant `chat.send` is written, `kill -9`, restart, reconnect |
| a long gap | disconnect boxbox, script more than 200 events, reconnect |
| provider failure | `fail: {mode: "drop"}` and `fail: {status: 500}` |
| an auto-archived thread | the bench config shortens the dashboard archive age (`just openclaw --archive-dashboard-after 20s`); the chaos client creates a `dashboard:` session and leaves it, and the gateway's own maintenance archives it as `stale-dashboard` (`sessions.cleanup {allAgents, enforce}` forces a pass). `sessions.patch` cannot write that reason (pinned by the first dev-gateway run) |
| held-thread gap | a client holds a thread, boxbox's socket is closed, the script commits more than 200 events (or the chaos client compacts) so the next delta resets, boxbox reconnects |

### 11.8 what the first dev-gateway run pinned

run on 2026-10-15 against 2026.10.1 with `bench/openclaw-open-items.ts`
(each answer printed with its evidence; the lane report holds the output):

- **loopback:** a `gateway-client`/`backend` connect with the shared token
  on loopback is admitted with no device, keeps all five operator scopes,
  and gets no device token.
- **the lan address is remote:** on the `--pairing manual` bench, the same
  device-less connect to the machine's own lan address is admitted with
  its scopes cleared (`[]`), so it is not loopback-local; a new device
  there gets `NOT_PAIRED`/`PAIRING_REQUIRED` with a `requestId`, `devices
  approve <requestId>` approves it, and it reconnects with all five scopes
  and a device token (the v3 signature accepted). no container is needed.
- **transcript block tags:** user content is a string, with inbound media
  as `__openclaw.media[]` (`kind` image, audio; `media://inbound/...`
  urls); assistant blocks `text`, `thinking`, `toolCall`, `image`, `audio`
  (`artifactId`, `url` under `/api/chat/media/outgoing/...`, `mimeType`);
  `toolResult` rows of `text`; `ask_user` adds a `custom` row of `toolCall`
  and `toolResult`; resets and compactions are `system` rows with
  `__openclaw.kind` `reset` or `compaction`; tts and reply-to are
  `openclawDelivery.tts` and `openclawDelivery.replyToCurrent` on the
  assistant row, a quote from boxbox `replyToId` and `replyToPreview` on
  the user row. no `attachment` block appeared.
- **`__openclaw.seq`:** tail rows carry it (1, 2, ...); a delta answer
  carries `activeLeafEntryId` at `sessionInfo.activeLeafEntryId`, and its
  rows are envelopes `{message, messageId, messageSeq, ...}`.
- **`chat.message.get`:** passes. a 160 kib reply is a 366-byte `oversized`
  placeholder in `chat.history`; `chat.message.get {maxChars: 1000000}` for
  its id returns the row whole. it stays on the allowlist.
- **`sessions.create` retry:** a retry with the same key adopts the first
  session and keeps its model and thinking level, with the same params or
  only `key` and `agentId`; asking a different thinking level needs
  `operator.admin` (refused without, applied with). an `idempotencyKey`
  needs a device identity.
- **stale-dashboard:** drivable as 11.7 says.
- **reminder:** "remind me in 2 minutes" sent with suppression on runs the
  scripted `automations` add, the job is created (owner the sending
  session) and fires about two minutes later, on the loopback bench and on
  the remote-path bench from a paired device over the lan address.
- **untested:** webm and ogg voice notes being heard (needs a transcription
  provider; the bench has none), and anything needing boxbox's server
  hooks.

## 12. verification

every test below runs against the dev gateway from section 11, started by
the test harness on a lane port, never against a mock of the gateway
(AGENTS.md, integration tests) and never against a real person's gateway (AGENTS.md, the live fleet). they live in
`server/src/openclaw/**/tests.rs` as `openclaw_live_*` tests (the server
is a binary crate, so `server/tests/` cannot reach its modules; cargo,
`#[ignore]`d, run with `--ignored` when `BOXBOX_OPENCLAW_BENCH` names a
running bench's directory) and print the evidence they
assert on. unit tests run in `just check`: decoders on recorded fixtures,
the `Allowed` enum, the approval request's key set, **the approval
`request` decoder keeps exactly `sessionKey` and `agentId`** (5.9), the
receipt decision table in 7.1's order (absent is `uncertain`, never a
resend), the monotone merge rule (5.2), the overlap test (5.5: an evicted
index never passes, a new reset marker joins, `hasMore: false` exits),
every patch and create classifying as `operator.write` (section 4), and
the cursor state machine.

**contract**

- `openclaw_contract`: the drift test (2.4), both halves.
- `openclaw_allowlist`: the full scenario set with the send tap; nothing
  outside section 4 is sent, field lists included (`chat.send`,
  `sessions.patch`, `sessions.create`), and `chat.message.get` only for an
  `oversized` row in an open thread.
- `openclaw_message_get_proof` (**first dev-gateway run**): a scripted
  reply over 128 kib serialised makes `chat.history` answer the
  `oversized` placeholder; `chat.message.get {sessionKey, agentId,
  messageId, maxChars: 1000000}` for that id returns the row whole. if it
  answers `oversized` or anything short of the row, `chat.message.get`
  leaves the allowlist (section 4) before the milestone lands.
- `openclaw_handshake`: the v3 signature is accepted; `signedAt` is the
  challenge `ts` (the test skews boxbox's clock by 10 minutes and still
  connects); scopes and caps granted as asked, `session-scoped-events`
  included: an unsubscribed session's `chat` frames never reach boxbox,
  its own sends included.
- `openclaw_degraded_admin`: a pairing approved without `operator.admin`
  turns every send off with the agents screen's "approve admin on the
  gateway" state, and no `chat.send` without
  `suppressCommandInterpretation` is ever written.
- `openclaw_pairing`: the remote-path bench (11.6); the agents screen
  state shows the `requestId` instruction; `devices approve`; the device
  token is persisted and used on reconnect and as the http bearer; a
  revoked token falls back and asks again. `openclaw_loopback` checks the
  other path: no device token, the shared token used throughout.
- `openclaw_version_policy`: a fake version string (the harness edits the
  exported tree's version stamp in a scratch copy under `/tmp`) connects
  untested; a forced protocol mismatch refuses.

**sync**

- `openclaw_cold_start`: two agents become two boxbox agents (`agents.list`
  identity read once); every session a thread; tails and cursors stored.
- `openclaw_held_thread`: a client hydrates a thread and holds it; boxbox
  disconnects while 80 rows are committed and the next delta is forced to
  reset (11.7, held-thread gap); on reconnect every one of the 80 reaches the journal
  with `position` in transcript order, or the thread gets `thread.reset`;
  never a silent gap (5.5). an unwatched thread's new row is
  journaled and its media copied.
- `openclaw_read_cache`: with the gateway stopped and boxbox restarted, an
  opened thread is served from the cache with `x-boxbox-cache: stale`; an
  uncached one answers 503 `agent-down`; with the gateway back, one delta
  revalidates it and a reset tail replaces it.
- `openclaw_gap_free`: a 1000-word scripted stream plus tool steps, with
  the socket dropped mid-turn; every committed row reaches the journal
  exactly once, in order (hole 1, 2, 16).
- `openclaw_long_gap`: more than 200 events while disconnected: reset,
  adaptive tail, no gap, no duplicate (hole 10).
- `openclaw_resets`: compaction, `/new` (one tail, the marker joins, no
  `thread.reset`, earlier rows kept and reachable by the anchored
  backfill), an idle `preserve-tail` reset (no pre-reset tool row
  removed), rewind (cut rows removed, the kept prefix not duplicated), an
  acp-style `sessionId` change (the old generation finished by the
  looping anchored read) (holes 12, 18).
- `openclaw_restart_mid_turn`: `kill -9` with a held turn; `bootId`
  changes, the resumed turn is mirrored once, the pending approval settles
  as cancelled by restart, the question as dropped (hole 17).
- `openclaw_slow_consumer`: reader paused; recovery with no loss, shedding
  logged (5.8).
- `openclaw_archive_delete`: archive from boxbox and from the chaos client;
  the archived session is never read afterwards (hole 19); a delete
  removes only its generation (hole 9).
- `openclaw_cursorless`: an assistant error pending; tails instead of
  deltas, rate-limited, back to `valid` after (hole 13).
- `openclaw_truncation`: a reply over 8000 characters arrives live at
  8000, then at 100000 from a tail, and a later live or delta copy never
  shrinks it back; a row over 128 kib never replaces text boxbox holds
  with the placeholder (hole 20, 5.2).
- `openclaw_auto_archive`: a dashboard session archived by the chaos
  client as `stale-dashboard` shows archived; a send into it un-archives
  it with `expectedSessionId` and then lands once (5.7).

**sends and verbs**

- `openclaw_send_receipts`: lost ack on a send that succeeded (the custody
  row is deleted on promotion): boxbox finds the user row by
  `__openclaw.idempotencyKey` and does not resend; an absent receipt with
  no user row ends `uncertain` and is never resent; an interrupted input
  is resent once only when the session is idle; every branch of 7.1's
  table, and never a second user row or a second turn (hole 3).
- `openclaw_send_fence`: a send composed before a rewind answers 409
  `generation-changed` (stale `generation`) and, with the generation
  forged, `active-leaf-changed` from the gateway; a send composed before
  `/new` lands after the reset marker (7.1).
- `openclaw_send_across_restart`: socket closed at write, `kill -9`; the
  message lands exactly once; a first message of a new thread created
  with `sessions.create` has custody, and a create retried after a
  gateway restart adopts the same session by its key and keeps the first
  call's model and thinking level (hole 4, 7.4).
- `openclaw_queue_not_steer`: a send during a running turn queues behind
  it; the running turn's answer does not change (hole 21).
- `openclaw_slash_suppressed`: `/config get` sent from boxbox arrives as
  text, and the user row is an ordinary custody row with a receipt (hole
  24).
- `openclaw_reminder`: "remind me in 2 minutes" sent from boxbox (with
  `suppressCommandInterpretation: true`) creates the cron job, as the same
  text from an owner on a channel does, and the job fires; run once on
  the loopback bench and once on the remote-path bench (11.6), since the
  two differ in authority (section 13). the result is printed with the
  job's recorded origin.
- `openclaw_abort`, `openclaw_new_thread`, `openclaw_model_thinking`,
  `openclaw_read_state`, `openclaw_archive`: each verb's gateway echo; an
  automatic read with `expectedMarkedUnreadAt` does not clear a mark
  unread made meanwhile from the chaos client; an archive patch without
  `expectedSessionId` is never built.
- `openclaw_approval`: exec raises an ask **on the thread of
  `request.sessionKey`**, live and from the list poll, with the right
  options and "allow always" marked lasting; answering allows exactly
  once; a timed-out answer retried gets `applied: false` and still settles
  as boxbox's by `resolver`; an answer from the chaos client first settles
  it as answered elsewhere; a system-agent kind round-trips; an approval
  left unanswered reaches expiry, settles `expired` and writes
  `openclaw.approval_expired` (holes 5, 6, 22, 23; 3.5).
- `openclaw_question`: `ask_user` raises a question ask; the answer
  resolves it; expiry settles it; a resolve retried after its first write
  landed gets `QUESTION_ALREADY_TERMINAL` and boxbox settles it as its own
  answer from `question.get` (hole 6, 7.10).
- `openclaw_reactions`: set, list, live event, removal, `mirror.status`
  returned; on a fixture channel row in a group session the reaction is
  not offered.
- `openclaw_quotes`: a quote from boxbox records `replyToId` and
  `replyToPreview`; the agent's `[[reply_to]]` resolves; the id pinned as
  `__openclaw.id`.

**media**

- `openclaw_attachments`: an image and voice notes as `audio/mp4`,
  `audio/webm` and `audio/ogg` sent inline, each heard by the agent (the
  scripted model's request log shows the media understanding); the caps
  from `hello-ok`; an oversize frame refused before sending (hole 26).
- `openclaw_media_fetch`: a generated image (`MEDIA:` line, `src/media/parse-output.ts`),
  a tts voice reply with `spoken` text, an inbound voice note via
  assistant-media with `playback=1`, all copied once into the store; a
  202 preparing is retried; a deleted record shows missing and is tried
  again on the next sight; a reset makes old-generation media 404 only
  after boxbox already copied it (holes 27, 28).

**origins and kinds**

- `openclaw_origins`: a channel-shaped user row is not producible without a
  channel in the bench, so origin decoding is held to a fixture recorded
  from a real channel turn on a test gateway the owner runs (section 13);
  the scheduled origin is tested live with `cron.run` from the chaos
  client.

**the first dev-gateway run** records fixtures before the sync code is
written and settles what this spec could only read: that a tail row
carries `__openclaw.seq` and a delta answer `activeLeafEntryId`; that
`openclaw_message_get_proof` passes or `chat.message.get` leaves the
allowlist; that `openclaw_reminder` creates the job on both benches; the
adopt path of `sessions.create`; that webm and ogg voice notes are heard;
that the gateway classes its own lan address as remote (11.6); and that
`stale-dashboard` auto-archive can be driven from the chaos client.

a milestone that ships the openclaw source is done when every test above
passes in one run, with the run's output printed, and `ps` shows the bench
stopped afterwards (AGENTS.md, dev processes).

## 13. known limits

upstream gaps, recorded here and not worked around:

- **the agent's channel-delivered voice and images are text mirrors
  only.** when the agent answers on whatsapp with a voice note or an image, the
  transcript gets a mirror row with the text and a file name
  (`src/gateway/server-methods/deliver-transcript.ts:15-58`,
  `src/config/sessions/transcript-mirror.ts:45-60`) and no reference to the
  bytes. boxbox shows the text with "sent as a voice note on whatsapp" and
  no player. (re-synthesising with `tts.speak` would be a workaround, and
  `tts.*` is outside the allowlist.)
- **quotes made inside a channel cannot be resolved** when they quote the
  agent: the agent's rows store no delivered whatsapp message id
  (`src/gateway/server-methods/sessions-reactions.ts:59-65`), and channel
  turns write no `replyToPreview`. the quote is `{message: null, preview:
  null}` and the client draws "replied to a message on whatsapp".
- **the transcript of a voice note sent from boxbox is not stored** on the
  gateway (8.1); the device's own transcript is the only one shown.
- **a failed transcription is silent** on the gateway (the agent sees only a
  marker); boxbox shows nothing special, as whatsapp does.
- **rows too large for history** stay placeholders unless
  `openclaw_message_get_proof` keeps `chat.message.get` on the allowlist
  (section 4, hole 20); even then a stored line over 256 kib may answer
  `oversized`.
- **openclaw's avatar and emoji** are read through `agents.list` (3.8) but
  shown only once `docs/agents.md`'s agent shape carries them.
- **reactions from whatsapp** (the person's or the agent's) are not known
  to reach `session.reactions`; boxbox shows what the gateway lists.
- **channel origins are tested from a recorded fixture**, not live: the
  bench has no channel (12).
- **claiming `approvals` changes the gateway's behaviour** (3.5): with
  boxbox connected, approvals that would be denied at once for lack of a
  route wait for boxbox until they expire. deliberate, so every approval
  reaches boxbox; an unanswered one ends `expired` with a telemetry row.
- **a send composed before a `/new` lands after it**: `/new` keeps the
  `sessionId` and the generation, and nothing on `chat.send` can fence it
  (7.1).
- **cron-creator authority for boxbox turns.** a `chat.send` with
  `suppressCommandInterpretation: true` is "system generated"
  (`src/gateway/server-methods/chat-send-handler.ts:165-166`), and a system
  generated turn never gets the direct-operator cron-creator capability
  (`src/gateway/server-methods/cron-creator-authority-admission.ts:155-175`).
  traced to the end in the pinned tree (full trace kept with the review),
  this costs reminders **nothing**:
  - the automations tool is owner-only and hidden only when
    `senderIsOwner === false`; boxbox is the owner through its admin scope
    on the internal channel (`senderIsOwnerByScope`,
    `src/auto-reply/command-auth.ts:453-462`), and suppression changes
    only command access, never owner status (`:471-482`).
  - a plain add needs no capability: the tool's check passes on the
    embedded runner's complete tool-surface capture
    (`src/agents/tools/cron-tool.ts:472-490`;
    `src/agents/tools/cron-tool-write.ts:45-57`), the job gets `toolsAllow
    ["*"]`, and the gateway's `cron.add` with no grant goes straight
    through (`src/gateway/server-methods/cron.ts:437, 507-533`; the caller
    scope check returns nothing without a grant). the tree's own test
    creates a job with no admission and an owner sender
    (`src/gateway/server-methods/cron-creator-transports.integration.test.ts:54-99`).
  - a **remote** boxbox (the normal case, over the tailnet) would not get
    the capability even unsuppressed: it needs admin and either a direct
    loopback ingress or the control ui's client id
    (`cron-creator-authority-admission.ts:66-69`). a **loopback** boxbox
    loses only the "local" origin recorded on the job and the
    operator-turn authority of the presence and transcripts tools.
  - no stock option keeps command suppression and restores the
    capability: `systemProvenanceReceipt` and the goal and review
    suppressors also set "system generated"
    (`src/gateway/server-methods/chat-send-request.ts:137, 219-220, 333`),
    `turnKind` is derived from the text (`:252-253`), and posing as the
    control ui is impersonation and still blocked by suppression.
  **decision: keep suppression, change nothing.** "remind me at 5" from
  boxbox works as it does from whatsapp. `openclaw_reminder` (section 12)
  pins it on both benches. not traced to the end: on the codex harness
  rather than the embedded runtime, a default agent-turn reminder from a
  non-local boxbox may fail with "Configured MCP cron authority is no
  longer active" (system-event reminders still work); the test runs on the
  embedded runtime, and a gateway running the codex harness is a known
  difference until it is pinned.
