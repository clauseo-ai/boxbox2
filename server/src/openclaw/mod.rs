//! the openclaw source (`docs/openclaw.md`): boxbox as a role `operator`
//! client of an openclaw gateway, over one websocket per `[[openclaw]]`
//! entry.
//!
//! this phase is the connection: identity, pairing, the allowlist and the
//! client the sync engine and the verbs build on. `source::OpenclawSource`
//! puts it behind the seam's `AgentSource`, and the supervisor runs one per
//! entry; it publishes no agents until the sync engine lands.
//!
//! # using it
//!
//! ```ignore
//! let (client, mut events, connection) = openclaw::open(config, store)?;
//! let task = tokio::spawn(connection.run(shutdown.clone()));   // -> source::Exit
//!
//! // the event stream: one per connection, across every reconnect
//! while let Some(event) = events.recv().await {
//!     match event {
//!         Event::Connected(hello) => { /* hello.restarted, hello.offers("chat.history"), ... */ }
//!         Event::Frame(frame) => { /* frame.event, frame.seq, frame.gap, frame.decode::<T>() */ }
//!         Event::Disconnected { why } => { /* subscriptions are gone; resync on the next Connected */ }
//!     }
//! }
//!
//! // requests, from any clone of the client
//! let answer = client.request(Allowed::AgentsList).await?;        // waits for a queue slot (sync reads)
//! let answer = client.try_request(Allowed::ChatSend(send)).await?; // Busy at once when 8 wait (verbs)
//! let list: AgentsListResult = answer.decode()?;
//!
//! // the state, for the agents screen
//! let state = client.state();   // watch::Receiver<ConnectionState>
//! let status = state.borrow().connection_status(&config, synced, frames);  // SourceEvent::Connection
//! ```
//!
//! - **requests** are `wire::Allowed`, the allowlist: there is no other
//!   way to put a request on the socket. at most 4 are in flight and 8
//!   wait; `scheduler.rs` holds the per-kind limits of section 10
//!   (preparation one at a time, roster pages 250 ms apart, deltas 2 in
//!   flight and 10 a second, tails one at a time, one send per session a
//!   second). watch mode, a missing `operator.admin` for anything that
//!   starts a turn, and a method the hello did not offer are refused
//!   before the socket. `RequestError::never_sent` says whether a retry
//!   is safe; `Timeout` (30 s) and `Lost` are uncertain, never failed.
//! - **events** carry every gateway event frame except the connection's
//!   own (`connect.challenge`, `tick`, `shutdown`), with the outer `seq` and
//!   any gap in it. `Connected` always precedes the frames of its socket.
//!   the stream holds 4096 frames or 16 MiB (a frame's bytes are released
//!   when it is dropped); when it is full the reader stops reading, which
//!   is never mistaken for a dead socket, and the gateway eventually closes
//!   with 1008 "slow consumer", after which the task reconnects. a consumer
//!   must drain events while it awaits answers, or a full stream holds its
//!   answers until they time out. `Events::backlog().past_half()` is the
//!   cue to shed subscriptions (5.8).
//! - **state** (`state::ConnectionState`) is the pairing state machine:
//!   connecting, pairing with the request id and the approval command in
//!   `last_error`, connected (with `untested`, `missing_scopes`,
//!   `boot_id`), down, refused (protocol, retried every 30 minutes;
//!   methods and auth, not until the config changes, when `run` returns
//!   `Exit::Refused`).
//! - **restart detection**: `Hello::restarted` is true when the gateway's
//!   `bootId` changed since the previous hello of this task (or, with no
//!   boot id, its uptime went backwards). the last boot id lives in memory
//!   only; persisting it across boxbox restarts is the sync engine's
//!   cursor row (5.2).
//! - **credentials**: the device key is `device_key`'s pem file when set,
//!   else a pkcs#8 key boxbox makes once and keeps in `source_secrets`,
//!   with the instance id and the device token the gateway hands a paired
//!   device. none of them is ever logged.

pub mod client;
pub mod connection;
pub mod credentials;
pub mod identity;
pub mod protocol;
pub mod scheduler;
pub mod source;
pub mod state;
pub mod transcript;
pub mod wire;

pub use client::{
    Backlog, Client, Event, Events, Frame, GatewayError, Hello, RequestError, Response,
};
pub use connection::{Connection, TlsSetupError, open};
pub use state::{ConnectionState, Phase};
pub use wire::Allowed;
