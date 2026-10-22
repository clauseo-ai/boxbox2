//! the fleet actor: the one owner of the fleet model, the journal and the
//! list of live client streams (architecture: tasks, and who owns what).
//!
//! watchers send it decoded daemon events and fresh host reads; it applies
//! them to the model, runs each resulting change through protocol 3's
//! encoder (`encode.rs`: thread and order patches, 100 ms delta batches,
//! finished text once), appends each entry it gives to the journal once,
//! and hands the same bytes to every stream whose interest takes it.
//!
//! the stream map (`docs/protocol.md`, section 5) is its too: per stream its
//! id, its interest (the open thread, the layers under it, the children it
//! holds), the signed-in session that opened it and the last interest post
//! it applied. the overview reaches every stream; a transcript entry only
//! the streams whose interest holds its thread. a stream opens in one step:
//! `hello`, then a `reset` or the compact catch-up from its cursor (section
//! 9, built from `keys.rs` and the ring), then live, so between catch-up and
//! live there is no gap and no duplicate. an interest post swaps the filter
//! at the head and hands the stream one confirm block (`catchup` frames for
//! the threads that enter with a `since`, then the `interest` frame) behind
//! whatever is queued for it.
//!
//! a live stream's queue is bounded by bytes, not by count: a slow phone
//! can hold at most `OUTBOUND_CAP` here, then its stream is closed and it
//! resumes from its cursor (architecture: memory caps). a confirm block is
//! outside that cap, at most `catchup::BLOCK_BYTES` of catch-up and one in
//! flight per stream.
//!
//! needs and read state are the model's too (`needs.rs`, `read.rs`); the
//! actor carries their consequences out: notices to push, rows to
//! telemetry, and every raise, serve and mark to `boxbox.db` through one
//! writer task, so a restart forgets nothing.
//!
//! the actor's one clock flushes window tails that streamed text moved
//! while their session's last entry was too recent to send another
//! (`model::TAIL_EVERY_MS`), and text deltas whose 100 ms batch is due
//! (`encode::DELTA_EVERY_MS`); it sleeps only while one is held.
//!
//! the model asks for a window's tail to be read once per session
//! (`Effect::ReadTail`); the actor queues the request for the tail reader
//! (`upstream/tails.rs`), and the read comes back as an upstream message.

pub mod adopted;
pub mod board;
pub mod catchup;
pub mod clears;
pub mod colours;
pub mod encode;
pub mod keys;
pub mod model;
pub mod needs;
pub mod persist;
pub mod read;
#[cfg(feature = "record")]
pub mod record;
#[cfg(test)]
mod replay;
pub mod summary;
#[cfg(any(test, feature = "record"))]
pub mod tape;

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bytes::Bytes;
use serde::Serialize;
use serde_json::json;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::journal::{Cursor, Journal, frame_data, sse_frame};
use crate::push::presence::Looking;
use crate::push::{Push, Thread};
use crate::source::cmx2::translate;
use crate::source::{SourceEvent, ThreadFacts};
use crate::store::Store;
use crate::wire::{
    Change, ColourFrame, Control, ENCODER, Interest, InterestPost, JournalEntry, PROTOCOL,
    RepoColour, ResetReason,
};
use clears::Clears;
use colours::Colours;
use encode::Encoder;
use keys::StreamKeys;
use model::{
    ClearRefused, ColourRefused, Device, Effect, Model, ReadRefused, ReviewTarget, TailRequest,
};
use needs::{Moved, Need, Needs};
use read::{Mark, Reads};

/// events waiting for the actor. when it is full a watcher waits, which
/// stops it reading its socket; cmx2 then closes that stream at its own
/// 1 mb cap and the watcher resumes from its cursor. nothing is lost and
/// nothing here grows.
const UPSTREAM_CAPACITY: usize = 1024;
/// client stream requests waiting for the actor; a stream waits its turn.
const COMMAND_CAPACITY: usize = 256;
/// bytes a live stream may have queued before it is closed.
pub const OUTBOUND_CAP: usize = 512 * 1024;
/// layers under the stage a stream's interest holds, at most.
pub const MAX_UNDER: usize = 8;
/// children held for the stage and its layers, at most.
pub const MAX_HOLDS: usize = 16;
/// writes waiting for the store. a raise, a serve or a mark each; past this
/// the disk is stalled, and the write is dropped with a warning (the model
/// holds the truth; the next write of the same row carries it).
const PERSIST_CAPACITY: usize = 1024;
/// served needs `GET /api/needs` lists.
pub const SERVED_LISTED: usize = 50;
/// tail reads waiting for the reader: more than the windows there can be
/// (`model::MAX_ORDER`). when it is full a request is not queued and the
/// session goes back to unread, so the next change to it asks again.
pub const TAIL_REQUESTS: usize = 512;

/// what the sources and their supervisor send.
#[derive(Debug)]
#[allow(
    clippy::large_enum_variant,
    reason = "nearly every message is a source event; boxing it would allocate per event to shrink the rare removal"
)]
pub enum Upstream {
    /// a connection left the config: its agents go.
    HostRemoved(String),
    /// one source event for one agent of a connection.
    Source {
        connection: Arc<str>,
        agent: Arc<str>,
        /// increases across the whole connection, or none.
        seq: Option<u64>,
        event: crate::source::SourceEvent,
    },
}

/// where a client stream starts.
#[derive(Debug)]
pub enum From {
    /// no cursor: a first connection.
    Start,
    /// a cursor that does not parse.
    Malformed,
    At(Cursor),
}

/// the signed-in session that opened a stream: only it may post the
/// stream's interest. a digest of its token, never the token.
pub type Owner = [u8; 32];

/// what a client stream asks for when it opens.
#[derive(Debug)]
pub struct Opening {
    pub from: From,
    /// what it shows; checked against `MAX_UNDER` and `MAX_HOLDS` by the route.
    pub interest: Interest,
    /// per interest key it already holds, its `left` (`docs/protocol.md`, section 5).
    pub since: BTreeMap<String, u64>,
    pub owner: Owner,
    /// the id the stream logs under.
    pub log: u32,
}

/// a client stream's first frames (`hello`, the colour map, then a
/// `reset` or the catch-up ending in `caught`) and its live feed.
#[derive(Debug)]
pub struct Opened {
    pub frames: Vec<Bytes>,
    pub live: Live,
    /// the stream's id, as `hello` names it to interest posts.
    pub stream: u128,
}

/// what a stream's live channel carries.
#[derive(Debug)]
pub enum Feed {
    /// a journal entry or a colour, counted in the stream's queue.
    Frame(Bytes),
    /// an interest confirm: its `catchup` frames and then the `interest`
    /// frame, outside the queue's cap. the stream fires `drained` once it
    /// has taken the last of them.
    Block {
        frames: Vec<Bytes>,
        drained: CancellationToken,
    },
}

/// a stream's live feed: frames in journal order, the bytes queued in it
/// (the stream subtracts what it takes), and the token that closes it: the
/// actor fires it when the queue passed the cap or the stream stalled on a
/// confirm, and the stream when it ends.
#[derive(Debug)]
pub struct Live {
    pub frames: mpsc::UnboundedReceiver<Feed>,
    pub queued: Arc<AtomicUsize>,
    pub closed: CancellationToken,
}

/// how the actor took an interest post.
#[derive(Debug)]
pub enum Confirm {
    /// swapped; its confirm is on the stream's channel.
    Applied,
    /// not above the last one applied: nothing to do, and no confirm.
    Older,
    /// no such stream (it ended, or is another session's).
    NoSuchStream,
    /// the last confirm is still unread: ask again once `drained` fires (or
    /// `closed`, the stream gone), until 30 s after the block was `handed`
    /// to the stream; past that, say `stalled` with its `ask`.
    Busy {
        drained: CancellationToken,
        closed: CancellationToken,
        handed: tokio::time::Instant,
        ask: u64,
    },
}

/// the journal's view of one thread when a read starts (`docs/protocol.md`,
/// section 11).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Versions {
    /// the journal head when asked: the read's `x-boxbox-seq`.
    pub at: Cursor,
    /// the seq of the thread's newest transcript entry; none for a thread
    /// the journal does not know.
    pub v: Option<u64>,
    /// the seq of the newest entry that touched a message outside its newest turn.
    pub rv: Option<u64>,
    /// `wire::ENCODER`.
    pub encoder: u32,
}

#[derive(Debug, thiserror::Error)]
#[error("the fleet actor has stopped")]
pub struct Stopped;

#[derive(Debug)]
enum Command {
    Open {
        opening: Opening,
        reply: oneshot::Sender<Opened>,
    },
    Interest {
        stream: u128,
        owner: Owner,
        post: InterestPost,
        reply: oneshot::Sender<Confirm>,
    },
    /// a post waited until the block of `ask` was 30 s old, unread.
    Stalled {
        stream: u128,
        ask: u64,
    },
    /// the stream's body ended.
    Ended {
        stream: u128,
    },
    Versions {
        key: String,
        reply: oneshot::Sender<Versions>,
    },
    Snapshot {
        reply: oneshot::Sender<(Bytes, Cursor)>,
    },
    Needs {
        reply: oneshot::Sender<NeedsNow>,
    },
    Arm {
        key: String,
        client_id: String,
        device: Device,
    },
    Answering {
        host: String,
        ask: String,
        device: Device,
    },
    OwnAction {
        key: String,
    },
    MarkRead {
        key: String,
        device: Device,
        message: String,
        at: f64,
        reply: oneshot::Sender<Result<(), ReadRefused>>,
    },
    Clear {
        keys: Vec<String>,
        device: Device,
        reply: oneshot::Sender<Vec<(String, Result<(), ClearRefused>)>>,
    },
    ClearedAmong {
        rows: Vec<(String, f64)>,
        reply: oneshot::Sender<Vec<bool>>,
    },
    Adopt {
        host: String,
        thread: Box<ThreadFacts>,
        reply: oneshot::Sender<()>,
    },
    AdoptedKeys {
        reply: oneshot::Sender<Vec<String>>,
    },
    Places {
        host: String,
        reply: oneshot::Sender<HashSet<String>>,
    },
    Unadopt {
        key: String,
    },
    ReviewTarget {
        key: String,
        reply: oneshot::Sender<Option<ReviewTarget>>,
    },
    ReviewAnswered {
        key: String,
        device: Device,
    },
    ReviewGone {
        key: String,
    },
    ChooseColour {
        host: String,
        root: String,
        chosen: Option<u8>,
        reply: oneshot::Sender<Result<Chosen, ColourRefused>>,
    },
    Board(BoardCommand),
}

/// what the board's routes ask of the fleet (`board/routes.rs`).
#[derive(Debug)]
enum BoardCommand {
    Subscribe {
        wanted: board::Wanted,
        reply: oneshot::Sender<watch::Receiver<Bytes>>,
    },
    Left,
    Bindings(Vec<boxbox_board_wire::Binding>),
    Holds {
        what: board::Holds,
        reply: oneshot::Sender<bool>,
    },
    Read {
        key: String,
        device: Device,
        reply: oneshot::Sender<Result<(), ReadRefused>>,
    },
    Ask {
        agent: String,
        id: String,
        reply: oneshot::Sender<Option<crate::wire::Ask>>,
    },
}

/// a repo's colour as a person's choice left it, and whether `boxbox.db`
/// has it: true once the row is committed, false or dropped when the store
/// failed or its queue was full (the fleet still holds the choice, and every
/// stream has heard it).
#[derive(Debug)]
pub struct Chosen {
    pub colour: RepoColour,
    pub written: oneshot::Receiver<bool>,
}

/// the needs as they stand at one point of the journal.
#[derive(Debug)]
pub struct NeedsNow {
    pub open: Vec<Need>,
    pub served: Vec<Need>,
    /// the journal position they reflect: a stream resumed from here
    /// carries every later move.
    pub at: Cursor,
}

/// what the actor needs from the rest of the server.
#[derive(Debug)]
pub struct Wiring {
    pub push: Push,
    pub telemetry: crate::telemetry::Sender,
    pub store: Store,
    /// who is looking, as push sees it.
    pub looking: watch::Receiver<Vec<Looking>>,
    /// the needs and marks the store kept.
    pub needs: Needs,
    pub reads: Reads,
    /// the threads cleared off home.
    pub clears: Clears,
    /// the threads opened from history that the store kept, as `(key,
    /// thread)`; none for a row that no longer decodes.
    pub adopted: Vec<(String, Option<ThreadFacts>)>,
    /// each repo's colour.
    pub colours: Colours,
    /// where window tails to read go (`upstream/tails.rs`).
    pub tails: mpsc::Sender<TailRequest>,
    /// the stream as `boxbox.db` kept it (`persist::resume`).
    pub resumed: persist::Resumed,
}

/// what `boxbox.db` kept for the fleet.
#[derive(Debug)]
pub struct Restored {
    pub needs: Needs,
    pub reads: Reads,
    pub clears: Clears,
    pub adopted: Vec<(String, Option<ThreadFacts>)>,
    pub colours: Colours,
}

/// the ledger, the read marks, the clears, the adopted threads and the repo colours as
/// `boxbox.db` kept them.
///
/// # Errors
/// the store failed.
pub async fn restore(store: &Store) -> Result<Restored, crate::store::StoreError> {
    let now = crate::now_ms();
    store
        .call(move |connection| {
            let (open, served) = needs::load(connection, now)?;
            let marks = read::load(connection)?;
            let (clears, dropped) = Clears::restore(clears::load(connection)?);
            // rows past the cap would otherwise stay in the table for good
            for key in dropped {
                clears::remove(connection, &key)?;
            }
            let adopted = adopted::load(connection)?
                .into_iter()
                .filter_map(|(key, info)| {
                    let info = RawValue::from_string(info).ok()?;
                    // every kept row is a cmx2 session's info, as the daemon wrote it
                    Some((key, translate::thread_from_json(info).ok()))
                })
                .collect();
            let (colours, dropped) = Colours::restore(colours::load(connection)?);
            for subject in dropped {
                colours::remove(connection, &subject)?;
            }
            Ok(Restored {
                needs: Needs::restore(open, served),
                reads: Reads::restore(marks),
                clears,
                adopted,
                colours,
            })
        })
        .await
}

/// the handle every other task holds.
#[derive(Clone, Debug)]
pub struct Fleet {
    upstream: mpsc::Sender<Upstream>,
    commands: mpsc::Sender<Command>,
}

impl Fleet {
    #[must_use]
    pub fn upstream(&self) -> mpsc::Sender<Upstream> {
        self.upstream.clone()
    }

    /// a handle whose actor is gone: every command fails with `Stopped`. for
    /// tests of what holds a fleet handle and judges something else.
    #[cfg(test)]
    #[must_use]
    pub fn detached() -> Self {
        let (upstream, _) = mpsc::channel(1);
        let (commands, _) = mpsc::channel(1);
        Self { upstream, commands }
    }

    /// a handle whose actor takes every command and does nothing with it:
    /// a command without a reply succeeds, one with a reply fails with
    /// `Stopped`. for tests of routes that tell the fleet before they act.
    #[cfg(test)]
    #[must_use]
    pub fn listening() -> Self {
        let (upstream, mut events) = mpsc::channel(64);
        let (commands, mut taken) = mpsc::channel::<Command>(64);
        tokio::spawn(async move { while taken.recv().await.is_some() {} });
        tokio::spawn(async move { while events.recv().await.is_some() {} });
        Self { upstream, commands }
    }

    /// opens a client stream: its first frames and its live feed.
    ///
    /// # Errors
    /// the actor has stopped (the server is shutting down).
    pub async fn open(&self, opening: Opening) -> Result<Opened, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Open { opening, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// an interest post for `stream`, from `owner`.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn interest(
        &self,
        stream: u128,
        owner: Owner,
        post: InterestPost,
    ) -> Result<Confirm, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Interest {
            stream,
            owner,
            post,
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// `stream` did not read the confirm block of `ask` within 30 s of
    /// taking it: it is closed, and the client reconnects with its interest
    /// in the query. a block drained meanwhile, or a later one, keeps it.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn stalled(&self, stream: u128, ask: u64) -> Result<(), Stopped> {
        self.command(Command::Stalled { stream, ask }).await
    }

    /// a stream's body ended: it leaves the stream map. from a drop, so it
    /// never waits; one lost to a full queue leaves at the next frame the
    /// stream would have taken, or the next post naming it.
    pub fn stream_ended(&self, stream: u128) {
        let _ = self.commands.try_send(Command::Ended { stream });
    }

    /// the journal head and `key`'s versions (`docs/protocol.md`, section 11).
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn versions(&self, key: String) -> Result<Versions, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Versions { key, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// the whole fleet model as json, and the journal position it reflects.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn snapshot(&self) -> Result<(Bytes, Cursor), Stopped> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Snapshot { reply })
            .await
            .map_err(|_| Stopped)?;
        answer.await.map_err(|_| Stopped)
    }

    /// the open needs, the ones served lately, and the journal position
    /// they reflect.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn needs(&self) -> Result<NeedsNow, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Needs { reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a send from `device` is on its way to `key` with `client_id`: the
    /// turn it starts is armed for "done".
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn arm(&self, key: String, client_id: String, device: Device) -> Result<(), Stopped> {
        self.command(Command::Arm {
            key,
            client_id,
            device,
        })
        .await
    }

    /// `device` is answering `ask` on `host`.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn answering(
        &self,
        host: String,
        ask: String,
        device: Device,
    ) -> Result<(), Stopped> {
        self.command(Command::Answering { host, ask, device }).await
    }

    /// a person is stopping `key`'s turn.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn own_action(&self, key: String) -> Result<(), Stopped> {
        self.command(Command::OwnAction { key }).await
    }

    /// `device` has seen `key` through `message`, created at `at` on the
    /// daemon's clock.
    ///
    /// # Errors
    /// the actor has stopped (outer), or the session is unknown (inner).
    pub async fn mark_read(
        &self,
        key: String,
        device: Device,
        message: String,
        at: f64,
    ) -> Result<Result<(), ReadRefused>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::MarkRead {
            key,
            device,
            message,
            at,
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// clears each of `keys` off home on `device`'s behalf and says how
    /// each went (`model::Model::clear`).
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn clear(
        &self,
        keys: Vec<String>,
        device: Device,
    ) -> Result<Vec<(String, Result<(), ClearRefused>)>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Clear {
            keys,
            device,
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// which of these threads, each with the `time.updated` the daemon
    /// listed for it, are cleared off home now.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn cleared_among(&self, rows: Vec<(String, f64)>) -> Result<Vec<bool>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::ClearedAmong { rows, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a thread read from its daemon joins the fleet, if it is not in it.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn adopt(&self, host: String, thread: ThreadFacts) -> Result<(), Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Adopt {
            host,
            thread: Box::new(thread),
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// the threads opened from history that are adopted, held or waiting for their host's first read.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn adopted_keys(&self) -> Result<Vec<String>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::AdoptedKeys { reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// the project roots and session directories the fleet holds for `host`.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn places(&self, host: String) -> Result<HashSet<String>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Places { host, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a thread the daemon no longer has live (archived, or gone) is not adopted any more.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn unadopt(&self, key: String) -> Result<(), Stopped> {
        self.command(Command::Unadopt { key }).await
    }

    /// where `key` works and the checkout its open review need names; `None` when the
    /// fleet does not hold the session.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn review_target(&self, key: String) -> Result<Option<ReviewTarget>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::ReviewTarget { key, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// `device`'s reply to `key` went through boxbox and was taken: the review the agent asked
    /// for there is answered by it.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn review_answered(&self, key: String, device: Device) -> Result<(), Stopped> {
        self.command(Command::ReviewAnswered { key, device }).await
    }

    /// the daemon says the checkout `key` reviews is gone: its review need is served.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn review_gone(&self, key: String) -> Result<(), Stopped> {
        self.command(Command::ReviewGone { key }).await
    }

    /// sets the colour a person chose for the repo `root` on `host` (a slot of
    /// `colours::NAMES`), or none for automatic; every stream hears it. the
    /// repo's colour as it stands, and word of its write.
    ///
    /// # Errors
    /// the actor has stopped (outer), or the fleet knows no such repo (inner).
    pub async fn choose_colour(
        &self,
        host: String,
        root: String,
        chosen: Option<u8>,
    ) -> Result<Result<Chosen, ColourRefused>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::ChooseColour {
            host,
            root,
            chosen,
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a board stream's view: the actor builds the projection if no stream
    /// held one, and the receiver holds the current view.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn board_subscribe(
        &self,
        wanted: board::Wanted,
    ) -> Result<watch::Receiver<Bytes>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Board(BoardCommand::Subscribe { wanted, reply }))
            .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a board stream dropped its view: with none left the projection goes.
    /// from a drop, so it never waits. a `Left` lost to a full queue, or a
    /// subscribe whose stream was cancelled before it took its receiver,
    /// leaves the projection in memory until the next change reaches the
    /// actor, which finds no receiver and drops it; no timer runs meanwhile,
    /// since a projection with nothing to build has no deadline.
    pub fn board_left(&self) {
        let _ = self.commands.try_send(Command::Board(BoardCommand::Left));
    }

    /// the board's pairings as `boxbox.db` holds them now.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn board_bindings(
        &self,
        bindings: Vec<boxbox_board_wire::Binding>,
    ) -> Result<(), Stopped> {
        self.command(Command::Board(BoardCommand::Bindings(bindings)))
            .await
    }

    /// `device` has seen `key` through its newest message.
    ///
    /// # Errors
    /// the actor has stopped (outer), or the session is unknown (inner).
    pub async fn board_read(
        &self,
        key: String,
        device: Device,
    ) -> Result<Result<(), ReadRefused>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Board(BoardCommand::Read { key, device, reply }))
            .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// whether the fleet holds a thread, or the board's view a machine light
    /// (with no view held, it cannot say no).
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn board_holds(&self, what: board::Holds) -> Result<bool, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Board(BoardCommand::Holds { what, reply }))
            .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// the agent's open ask `id`, as its source told it.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn board_ask(
        &self,
        agent: String,
        id: String,
    ) -> Result<Option<crate::wire::Ask>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Board(BoardCommand::Ask { agent, id, reply }))
            .await?;
        answer.await.map_err(|_| Stopped)
    }

    async fn command(&self, command: Command) -> Result<(), Stopped> {
        self.commands.send(command).await.map_err(|_| Stopped)
    }
}

/// starts the actor with a fresh journal; it stops when `shutdown` fires.
#[must_use]
pub fn spawn(
    build: String,
    wiring: Wiring,
    shutdown: CancellationToken,
) -> (Fleet, JoinHandle<()>) {
    let (upstream_tx, upstream) = mpsc::channel(UPSTREAM_CAPACITY);
    let (commands_tx, commands) = mpsc::channel(COMMAND_CAPACITY);
    let (persist, persisted) = mpsc::channel(PERSIST_CAPACITY);
    tokio::spawn(persister(wiring.store.clone(), persisted));
    // the stream's own batches: one in flight, each answered (`persist.rs`)
    let (batch_tx, batch_rx) = mpsc::channel(1);
    let (acks_tx, acks) = mpsc::channel(1);
    tokio::spawn(persist::writer(wiring.store, batch_rx, acks_tx));
    let resumed = wiring.resumed;
    let (open_needs, clears, colours) = (
        wiring.needs.open_count(),
        wiring.clears.len(),
        wiring.colours.len(),
    );
    let mut model = Model::restored(
        wiring.needs,
        wiring.reads,
        wiring.clears,
        wiring.adopted,
        wiring.colours,
    );
    let broken = model.resume(resumed.model);
    info!(
        epoch = resumed.epoch,
        head = resumed.head,
        how = ?resumed.how,
        sessions = model.session_count(),
        broken,
        open_needs,
        clears,
        colours,
        "journal started"
    );
    let mut actor = Actor {
        model,
        journal: Journal::resumed(resumed.epoch, resumed.head),
        encoder: resumed.encoder,
        keys: resumed.keys,
        live: Vec::new(),
        board: None,
        build,
        tails: wiring.tails,
        outside: Outside {
            push: wiring.push,
            telemetry: wiring.telemetry,
            persist,
            ack: None,
        },
        persist: persist::Persist::new(resumed.reserved, resumed.graves, Some(batch_tx)),
        cursors: resumed.cursors,
        unasked: Vec::new(),
    };
    if resumed.rewrite || broken > 0 {
        actor.mark_all();
    }
    actor.started(resumed.how, &resumed.broken.threads);
    let task = tokio::spawn(actor.run(upstream, commands, acks, wiring.looking, shutdown));
    (
        Fleet {
            upstream: upstream_tx,
            commands: commands_tx,
        },
        task,
    )
}

/// one entry of the stream map.
#[derive(Debug)]
struct Subscriber {
    /// what `hello` named it; interest posts name it so.
    id: u128,
    /// the id it logs under.
    log: u32,
    owner: Owner,
    interest: Interest,
    /// the keys of `interest`, for the filter.
    keys: HashSet<String>,
    /// the last interest post applied.
    asked: u64,
    frames: mpsc::UnboundedSender<Feed>,
    queued: Arc<AtomicUsize>,
    closed: CancellationToken,
    /// its last confirm block.
    block: Option<Block>,
}

/// a confirm block handed to a stream.
#[derive(Debug)]
struct Block {
    /// fires when the stream has taken it.
    drained: CancellationToken,
    /// when it went on the stream's channel: its 30 s run from here.
    handed: tokio::time::Instant,
    /// the post it confirms.
    ask: u64,
}

/// an interest's keys, the stage first, each once.
fn interest_keys(interest: &Interest) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for key in interest
        .thread
        .iter()
        .chain(&interest.under)
        .chain(&interest.holds)
    {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    keys
}

/// what one key's catch-up from its `since` is.
#[derive(Debug)]
enum KeyCatch {
    /// reset after its `since`: the client drops its messages and reads it.
    Reset,
    /// the compacted entries (none when nothing moved).
    Entries(Vec<JournalEntry>),
    /// the ring no longer holds them, or the journal does not know the key.
    Stale,
}

/// the catch-up of several keys within one block's cap.
#[derive(Debug, Default)]
struct Caught {
    frames: Vec<Bytes>,
    stale: Vec<String>,
    reset: Vec<String>,
}

#[derive(Debug)]
struct Actor {
    model: Model,
    journal: Journal,
    /// protocol 3's encoder: the patch bases, the pending deltas and the
    /// finished-text tracking, owned with the journal they feed.
    encoder: Encoder,
    /// per key the newest entry, the threads' versions, the tombstones.
    keys: StreamKeys,
    /// the stream map.
    live: Vec<Subscriber>,
    /// the board's projection, only while a board stream listens.
    board: Option<board::Projection>,
    build: String,
    tails: mpsc::Sender<TailRequest>,
    outside: Outside,
    /// dirty marks and the one batch in flight (`persist.rs`).
    persist: persist::Persist,
    /// threads whose newest messages could not be asked for: reset once
    /// the step's effects are carried out.
    unasked: Vec<String>,
    /// each connection's cursor whose effects the model holds: its epoch
    /// from the last host read, its seq the newest event applied.
    cursors: std::collections::HashMap<String, Cursor>,
}

/// where the model's effects go.
#[derive(Debug)]
struct Outside {
    push: Push,
    telemetry: crate::telemetry::Sender,
    persist: mpsc::Sender<Persist>,
    /// where the next repo colour write reports its commit: set only while a
    /// person's choice is carried out.
    ack: Option<oneshot::Sender<bool>>,
}

/// one write for `boxbox.db`.
#[derive(Debug)]
enum Persist {
    Need(Need),
    Read {
        key: String,
        mark: Mark,
    },
    Forget(String),
    Clear {
        key: String,
        clear: clears::Clear,
    },
    Unclear(String),
    Adopt {
        key: String,
        info: String,
        at: i64,
    },
    Unadopt(String),
    /// with where to say it was committed, for a person's choice.
    Colour(colours::Write, Option<oneshot::Sender<bool>>),
}

/// the fleet's writer: raises, serves and marks go to the store in order,
/// one at a time, off the actor.
async fn persister(store: Store, mut writes: mpsc::Receiver<Persist>) {
    while let Some(mut write) = writes.recv().await {
        let ack = match &mut write {
            Persist::Colour(_, ack) => ack.take(),
            _ => None,
        };
        let what = match &write {
            Persist::Need(need) => format!("need {}", need.id),
            Persist::Read { key, .. } => format!("read mark on {key}"),
            Persist::Forget(key) => format!("read marks of {key}"),
            Persist::Clear { key, .. } => format!("clear mark on {key}"),
            Persist::Unclear(key) => format!("clear mark of {key}"),
            Persist::Adopt { key, .. } | Persist::Unadopt(key) => format!("adopted thread {key}"),
            Persist::Colour(
                colours::Write::Put { host, root, .. } | colours::Write::Remove { host, root },
                _,
            ) => format!("colour of {host}:{root}"),
        };
        let written = store
            .call(move |connection| match write {
                Persist::Need(need) => needs::save(connection, &need),
                Persist::Read { key, mark } => read::save(connection, &key, &mark),
                Persist::Forget(key) => read::remove(connection, &key),
                Persist::Clear { key, clear } => clears::save(connection, &key, clear),
                Persist::Unclear(key) => clears::remove(connection, &key),
                Persist::Adopt { key, info, at } => adopted::save(connection, &key, &info, at),
                Persist::Unadopt(key) => adopted::remove(connection, &key),
                Persist::Colour(write, _) => colours::save(connection, &write),
            })
            .await;
        if let Some(ack) = ack {
            let _ = ack.send(written.is_ok());
        }
        if let Err(error) = written {
            warn!(%error, what, "the fleet could not write to the store; it holds the truth in memory until the next write");
        }
    }
}

impl Actor {
    async fn run(
        mut self,
        mut upstream: mpsc::Receiver<Upstream>,
        mut commands: mpsc::Receiver<Command>,
        mut acks: mpsc::Receiver<persist::Ack>,
        mut looking: watch::Receiver<Vec<Looking>>,
        shutdown: CancellationToken,
    ) {
        let mut watching = true;
        let mut tick = tokio::time::interval(persist::TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut stopped_at: Option<std::time::Instant> = None;
        loop {
            let due = self.model.tail_due();
            let deltas_due = self.encoder.due();
            let board_due = self.board.as_ref().and_then(board::Projection::due);
            let now = std::time::Instant::now();
            // the byte cap and the reserved mark (`persist.rs`): source events wait in their channel
            let intake = self.persist.intake_open(self.journal.head(), now);
            match (intake, stopped_at) {
                (false, None) => {
                    warn!(
                        dirty_bytes = self.persist.dirty_bytes(),
                        waiting = self.persist.in_flight(),
                        head = self.journal.head(),
                        "source intake stops until the stream state is written"
                    );
                    stopped_at = Some(now);
                }
                (true, Some(at)) => {
                    info!(
                        ms = u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX),
                        "source intake resumes"
                    );
                    stopped_at = None;
                }
                _ => {}
            }
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                Some(ack) = acks.recv() => {
                    self.persist.acknowledged(&ack, std::time::Instant::now());
                }
                _ = tick.tick() => {
                    if self.persist.due(self.journal.head()) {
                        let batch = self.take_batch(false);
                        self.send_batch(batch).await;
                    }
                }
                // a client waiting on its page is served before the next event
                Some(command) = commands.recv() => self.command(command),
                // ahead of the events, so a stream of them cannot starve held text
                () = tokio::time::sleep(until(deltas_due)), if deltas_due.is_some() => self.flush_deltas(),
                () = tokio::time::sleep(until(due)), if due.is_some() => self.flush_tails(),
                // exists only while a board listens and its picture may move
                () = tokio::time::sleep_until(board_due.unwrap_or_else(tokio::time::Instant::now)), if board_due.is_some() => self.board_tick(),
                changed = looking.changed(), if watching => match changed {
                    Ok(()) => {
                        let devices = looking.borrow_and_update().clone();
                        self.looking(devices);
                    }
                    // push has stopped: the server is going down
                    Err(_) => watching = false,
                },
                Some(message) = upstream.recv(), if intake => self.upstream(message),
                else => break,
            }
        }
        // a clean stop: the text still waiting for its batch goes before the streams' last frames
        let pending = self.encoder.flush();
        self.journal_all(pending);
        self.stop_clean(&mut acks).await;
        info!(
            head = self.journal.head(),
            entries = self.journal.len(),
            bytes = self.journal.bytes(),
            sessions = self.model.session_count(),
            "fleet actor stopped"
        );
    }

    #[allow(clippy::too_many_lines, reason = "one arm per command")]
    fn command(&mut self, command: Command) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::command(now, &command);
        self.model.at(now);
        match command {
            Command::Needs { reply } => {
                let _ = reply.send(NeedsNow {
                    open: self.model.needs_open(),
                    served: self.model.needs_served(SERVED_LISTED),
                    at: self.cursor(self.journal.head()),
                });
            }
            Command::Arm {
                key,
                client_id,
                device,
            } => {
                // the order row keeps the sends, answers and stops (`model/state.rs`)
                self.persist.mark(persist::Key::Order);
                self.model.arm(&key, &client_id, device);
            }
            Command::Answering { host, ask, device } => {
                self.persist.mark(persist::Key::Order);
                self.model.answering(&host, &ask, device);
            }
            Command::OwnAction { key } => {
                self.persist.mark(persist::Key::Order);
                self.model.own_action(&key);
            }
            Command::MarkRead {
                key,
                device,
                message,
                at,
                reply,
            } => {
                let answer = self.model.read(&key, &device, &message, at).map(|changes| {
                    self.publish_all(changes);
                });
                let _ = reply.send(answer);
            }
            Command::Clear {
                keys,
                device,
                reply,
            } => {
                let (changes, answers) = self.model.clear(&keys, &device);
                self.publish_all(changes);
                let _ = reply.send(answers);
            }
            Command::ClearedAmong { rows, reply } => {
                let _ = reply.send(self.model.cleared_among(&rows));
            }
            Command::Adopt {
                host,
                thread,
                reply,
            } => {
                self.persist
                    .mark(persist::Key::Thread(model::session_key(&host, &thread.id)));
                let changes = self.model.adopt_thread(&host, *thread);
                self.publish_all(changes);
                let _ = reply.send(());
            }
            Command::AdoptedKeys { reply } => {
                let _ = reply.send(self.model.adopted_keys());
            }
            Command::ReviewAnswered { key, device } => {
                let changes = self.model.review_answered(&key, &device);
                self.publish_all(changes);
            }
            Command::ReviewGone { key } => {
                let changes = self.model.review_gone(&key);
                self.publish_all(changes);
            }
            Command::ReviewTarget { key, reply } => {
                let _ = reply.send(self.model.review_target(&key));
            }
            Command::Places { host, reply } => {
                let _ = reply.send(self.model.places(&host));
            }
            Command::Unadopt { key } => {
                self.persist.mark(persist::Key::Thread(key.clone()));
                let changes = self.model.unadopt(&key);
                self.publish_all(changes);
            }
            Command::ChooseColour {
                host,
                root,
                chosen,
                reply,
            } => {
                let _ = reply.send(self.choose_colour(&host, &root, chosen));
            }
            Command::Open { opening, reply } => {
                // a stream that went away while it waited needs nothing; it
                // leaves the map at the first frame it would have taken
                let _ = reply.send(self.open(&opening));
            }
            Command::Interest {
                stream,
                owner,
                post,
                reply,
            } => {
                let _ = reply.send(self.interest(stream, owner, &post));
            }
            Command::Stalled { stream, ask } => {
                // a block drained as the post's wait ran out is no stall, nor
                // is a younger block after it: the stream is read, and stays open
                let unread = |s: &Subscriber| {
                    s.block
                        .as_ref()
                        .is_some_and(|b| b.ask == ask && !b.drained.is_cancelled())
                };
                if let Some(at) = self.live.iter().position(|s| s.id == stream && unread(s)) {
                    let s = self.live.remove(at);
                    warn!(stream = %format_args!("{:08x}", s.log), "the client did not read its interest confirm in 30 s; closing its stream");
                    s.closed.cancel();
                }
            }
            Command::Ended { stream } => self.live.retain(|s| s.id != stream),
            Command::Versions { key, reply } => {
                let thread = self.keys.thread(&key);
                let _ = reply.send(Versions {
                    at: self.cursor(self.journal.head()),
                    v: thread.map(|t| t.v),
                    rv: thread.map(|t| t.rv),
                    encoder: ENCODER,
                });
            }
            Command::Board(command) => self.board_command(command),
            Command::Snapshot { reply } => match serde_json::to_vec(&self.journaled()) {
                Ok(json) => {
                    let _ = reply.send((Bytes::from(json), self.cursor(self.journal.head())));
                }
                Err(e) => error!(error = %e, "the fleet snapshot did not serialize"),
            },
        }
    }

    /// a person's choice of colour: sent to every stream that asked for
    /// colours at once, and answered with word of the row's commit.
    fn choose_colour(
        &mut self,
        host: &str,
        root: &str,
        chosen: Option<u8>,
    ) -> Result<Chosen, ColourRefused> {
        let (colour, moved) = self.model.choose_colour(host, root, chosen)?;
        if moved {
            self.colour(colour.clone());
        }
        // the choice's row takes the acknowledgement on its way to the writer,
        // even when nothing moved: it may retry a write that was dropped
        let (ack, written) = oneshot::channel();
        self.outside.ack = Some(ack);
        self.publish_all(Vec::new());
        self.outside.ack = None;
        Ok(Chosen { colour, written })
    }

    fn upstream(&mut self, message: Upstream) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::upstream(now, &message);
        self.model.at(now);
        let changes = match message {
            Upstream::HostRemoved(host) => {
                self.mark_host(&host);
                self.cursors.remove(&host);
                self.model.host_removed(&host)
            }
            Upstream::Source {
                connection,
                agent,
                seq,
                event,
            } => {
                self.mark_event(&connection, &agent, seq, &event);
                let read = matches!(event, SourceEvent::Snapshot(_));
                if read {
                    self.mark_host(&agent);
                }
                let changes = self.source_event(&agent, seq, event);
                if read {
                    self.mark_host(&agent);
                }
                changes
            }
        };
        self.publish_all(changes);
    }

    fn source_event(&mut self, agent: &str, seq: Option<u64>, event: SourceEvent) -> Vec<Change> {
        let agent = agent.to_owned();
        match event {
            SourceEvent::Connection(status) => {
                if let Some(projection) = &mut self.board {
                    projection.connection_moved();
                }
                self.model.connection(status)
            }
            SourceEvent::Snapshot(read) => {
                let (epoch, sessions) = (read.epoch.clone(), read.threads.len());
                let changes = self.model.agent_read(&agent, *read);
                info!(
                    host = %agent,
                    epoch = epoch.as_deref().unwrap_or("-"),
                    sessions,
                    "fleet replaced the host from its reads"
                );
                changes
            }
            SourceEvent::TailRead(read) => self.model.tail(&agent, *read),
            SourceEvent::NewestRead(read) => self.model.newest_read(&agent, *read),
            SourceEvent::NewestUnread { thread, reason } => {
                let key = model::session_key(&agent, &thread);
                warn!(
                    session = key,
                    reason, "a thread's newest messages could not be read after a gap; it is reset"
                );
                self.model.newest_failed(&key)
            }
            SourceEvent::TailUnread { thread, reason } => {
                let key = model::session_key(&agent, &thread);
                warn!(
                    session = key,
                    reason,
                    "a window's tail could not be read; it shows what streams, and is read again when its host is"
                );
                self.model.tail_failed(&key);
                Vec::new()
            }
            event => self.model.source(&agent, seq, event),
        }
    }

    fn looking(&mut self, devices: Vec<Looking>) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::looking(now, &devices);
        self.model.at(now);
        let moved = self.model.looking(devices);
        self.publish_all(moved);
    }

    fn flush_tails(&mut self) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::flush_tails(now);
        self.model.at(now);
        let changes = self.model.flush_tails();
        self.publish_all(changes);
    }

    /// the text deltas whose 100 ms batch is due go into the journal.
    fn flush_deltas(&mut self) {
        let due = self.encoder.flush_due(crate::now_ms());
        self.journal_all(due);
    }

    /// one batch of every dirty row, the new tombstones, the head, the
    /// reserved mark and every cursor, taken in this one step
    /// (`docs/protocol.md`, section 10).
    fn take_batch(&mut self, clean: bool) -> persist::Batch {
        let head = self.journal.head();
        let dirty = self.persist.dirty_keys();
        let writes: Vec<persist::Write> = dirty
            .iter()
            .map(|key| persist::row(key, &self.model, &self.keys, &self.encoder))
            .collect();
        let (bytes, sizes) = persist::sized(&writes, &dirty);
        if bytes > persist::BATCH_BYTES {
            warn!(
                bytes,
                rows = writes.len(),
                cap = persist::BATCH_BYTES,
                "a stream state batch passed its cap"
            );
        }
        let mut cursors: Vec<(String, Cursor)> = self
            .cursors
            .iter()
            .map(|(c, at)| (c.clone(), at.clone()))
            .collect();
        cursors.sort_by(|a, b| a.0.cmp(&b.0));
        let batch = persist::Batch {
            id: self.persist.next_id(),
            epoch: self.journal.epoch().to_owned(),
            head,
            reserved: self.persist.next_reserved(head),
            clean,
            gone_floor: self.keys.gone_floor(),
            writes,
            graves: self
                .keys
                .graves_after(self.persist.graves_written())
                .collect(),
            cursors,
            bytes,
        };
        self.persist.taken(&batch, sizes, std::time::Instant::now());
        batch
    }

    /// hands a batch to the writer: the channel holds one, and none is in
    /// flight when a batch is taken, so this does not wait.
    async fn send_batch(&mut self, batch: persist::Batch) {
        let Some(writer) = &self.persist.batches else {
            return;
        };
        if writer.send(batch).await.is_err() {
            error!("the stream state writer has stopped; nothing more is written");
        }
    }

    /// the last batch with `clean = 1`, once every earlier one is answered,
    /// inside `persist::SHUTDOWN_BUDGET`; past it the next start takes the
    /// crash path.
    async fn stop_clean(&mut self, acks: &mut mpsc::Receiver<persist::Ack>) {
        if self.persist.batches.is_none() {
            return;
        }
        let deadline = tokio::time::Instant::now() + persist::SHUTDOWN_BUDGET;
        while self.persist.in_flight() {
            let Ok(Some(ack)) = tokio::time::timeout_at(deadline, acks.recv()).await else {
                warn!(
                    "a stream state batch was not answered inside the shutdown budget; the next start takes the crash path"
                );
                return;
            };
            self.persist.acknowledged(&ack, std::time::Instant::now());
        }
        let batch = self.take_batch(true);
        let (id, rows) = (batch.id, batch.writes.len());
        self.send_batch(batch).await;
        match tokio::time::timeout_at(deadline, acks.recv()).await {
            Ok(Some(ack))
                if ack.id == id && self.persist.acknowledged(&ack, std::time::Instant::now()) =>
            {
                info!(
                    head = self.journal.head(),
                    rows, "the stream stopped clean; a restart resumes from here"
                );
            }
            _ => warn!(
                "the last stream state batch was not written inside the shutdown budget; the next start takes the crash path"
            ),
        }
    }

    /// what a start journals before any stream is served
    /// (`docs/protocol.md`, section 10): the threads whose kept model rows
    /// did not decode leave (their hosts are read again and bring them back
    /// reset); after a crash, every key whose state moved past its kept body
    /// goes out (read marks, clears and needs reach their own tables at once,
    /// the stream's batch up to a second later); and the newest-message reads
    /// a quiet re-read left out are asked again.
    fn started(&mut self, how: persist::How, lost: &[String]) {
        self.model.at(crate::now_ms());
        let mut changes: Vec<Change> = lost
            .iter()
            .filter(|key| self.keys.thread(key).is_some() || self.encoder.base(key).is_some())
            .map(|key| Change::ThreadRemoved { key: key.clone() })
            .collect();
        if how == persist::How::Crash {
            changes.extend(self.differences());
        }
        if !changes.is_empty() {
            info!(
                entries = changes.len(),
                "the start journals what moved past the kept state"
            );
        }
        self.model.ask_newest_again();
        self.publish_all(changes);
    }

    /// each agent, thread, open ask and the order whose model state differs
    /// from the body the journal last told, as the whole change the encoder
    /// patches against it.
    fn differences(&self) -> Vec<Change> {
        let fleet = self.model.snapshot();
        let mut changes = Vec::new();
        for agent in fleet.agents {
            if self.keys.agent(&agent.key).map(|k| &k.body) != Some(&agent) {
                changes.push(Change::Agent { agent });
            }
        }
        for thread in fleet.threads {
            if self.encoder.base(&thread.key) != Some(&thread) {
                changes.push(Change::Thread { thread });
            }
        }
        for ask in fleet.asks {
            if self.keys.ask(&ask.agent, &ask.id).map(|k| &k.body) != Some(&ask) {
                changes.push(Change::Ask { ask });
            }
        }
        if self.encoder.order_base() != Some(fleet.order.as_slice()) {
            changes.push(Change::Order { keys: fleet.order });
        }
        changes
    }

    /// every row goes in the next batch: a crash start, another encoder.
    fn mark_all(&mut self) {
        let (threads, agents, asks) = self.model.held_keys();
        let (more_threads, more_agents, more_asks) = self.keys.held_keys();
        for key in threads.into_iter().chain(more_threads) {
            self.persist.mark(persist::Key::Thread(key));
        }
        for key in agents.into_iter().chain(more_agents) {
            self.persist.mark(persist::Key::Agent(key));
        }
        for (agent, id) in asks.into_iter().chain(more_asks) {
            self.persist.mark(persist::Key::Ask(agent, id));
        }
        self.persist.mark(persist::Key::Order);
    }

    /// every row of one agent: a host read or removal replaces them all.
    fn mark_host(&mut self, agent: &str) {
        let prefix = format!("{agent}:");
        let (threads, _, asks) = self.model.held_keys();
        let (more_threads, _, more_asks) = self.keys.held_keys();
        for key in threads.into_iter().chain(more_threads) {
            if key.starts_with(&prefix) {
                self.persist.mark(persist::Key::Thread(key));
            }
        }
        for (owner, id) in asks.into_iter().chain(more_asks) {
            if owner == agent {
                self.persist.mark(persist::Key::Ask(owner, id));
            }
        }
        self.persist.mark(persist::Key::Agent(agent.to_owned()));
        self.persist.mark(persist::Key::Order);
    }

    /// the rows a source event moves the model's own state for, beside what
    /// it journals; and the connection's cursor.
    fn mark_event(&mut self, connection: &str, agent: &str, seq: Option<u64>, event: &SourceEvent) {
        self.persist.mark(persist::Key::Agent(agent.to_owned()));
        // a send landing takes its arm off the order row's list
        if matches!(event, SourceEvent::Message { .. }) {
            self.persist.mark(persist::Key::Order);
        }
        let thread = match event {
            SourceEvent::Thread { thread, .. } => Some(thread.id.as_str()),
            SourceEvent::ThreadRemoved { thread }
            | SourceEvent::ThreadReset { thread }
            | SourceEvent::Activity { thread, .. }
            | SourceEvent::TurnEnded { thread }
            | SourceEvent::Send { thread, .. }
            | SourceEvent::Message { thread, .. }
            | SourceEvent::Part { thread, .. }
            | SourceEvent::Delta { thread, .. }
            | SourceEvent::MessageRemoved { thread, .. }
            | SourceEvent::Reactions { thread, .. }
            | SourceEvent::Btw { thread, .. }
            | SourceEvent::BtwDelta { thread, .. }
            | SourceEvent::Fault { thread, .. }
            | SourceEvent::Notice { thread, .. }
            | SourceEvent::TailUnread { thread, .. }
            | SourceEvent::NewestUnread { thread, .. } => Some(thread.as_str()),
            SourceEvent::TailRead(read) | SourceEvent::NewestRead(read) => {
                Some(read.thread.as_str())
            }
            SourceEvent::AskRaised { ask } => {
                self.persist
                    .mark(persist::Key::Ask(ask.agent.clone(), ask.id.clone()));
                None
            }
            SourceEvent::AskSettled { ask, .. } => {
                self.persist
                    .mark(persist::Key::Ask(agent.to_owned(), ask.clone()));
                // an answer through boxbox is taken off the order row's list
                self.persist.mark(persist::Key::Order);
                None
            }
            SourceEvent::Snapshot(read) => {
                if let Some(epoch) = &read.epoch {
                    let f = read.floors;
                    let seq = f
                        .threads
                        .min(f.activities)
                        .min(f.permissions)
                        .min(f.questions);
                    self.cursors.insert(
                        connection.to_owned(),
                        Cursor {
                            epoch: epoch.clone(),
                            seq,
                        },
                    );
                }
                None
            }
            SourceEvent::Connection(_)
            | SourceEvent::Agents(_)
            | SourceEvent::ReviewSettled { .. }
            | SourceEvent::Replaying
            | SourceEvent::CaughtUp
            | SourceEvent::Skipped => None,
        };
        if let Some(thread) = thread {
            self.persist
                .mark(persist::Key::Thread(model::session_key(agent, thread)));
        }
        if let Some(seq) = seq
            && let Some(cursor) = self.cursors.get_mut(connection)
        {
            cursor.seq = cursor.seq.max(seq);
        }
    }

    /// journals the model's changes through the encoder, each new repo's
    /// colour ahead of them, then carries the model's effects out.
    fn publish_all(&mut self, changes: Vec<Change>) {
        for colour in self.model.assign_colours(&changes) {
            self.colour(colour);
        }
        if let Some(projection) = &mut self.board {
            let now = tokio::time::Instant::now();
            for change in &changes {
                projection.saw(change, now);
            }
        }
        let now = crate::now_ms();
        for change in changes {
            let entries = self.encode(now, change);
            self.journal_all(entries);
        }
        if self.board.is_some() {
            self.board_tick();
        }
        for effect in self.model.drain() {
            match effect {
                Effect::ReadTail(request) => self.ask_tail(request),
                effect => self.outside.effect(effect),
            }
        }
        for key in std::mem::take(&mut self.unasked) {
            let reset = self.model.newest_failed(&key);
            self.publish_all(reset);
        }
    }

    fn board_command(&mut self, command: BoardCommand) {
        match command {
            BoardCommand::Subscribe { wanted, reply } => {
                let receiver = match &mut self.board {
                    Some(projection) if !projection.is_closed() => projection.subscribe(wanted),
                    _ => {
                        let (projection, receiver) =
                            board::Projection::start(wanted, &self.model, board::Clock::now());
                        info!("the board's view started");
                        self.board = Some(projection);
                        receiver
                    }
                };
                let _ = reply.send(receiver);
            }
            BoardCommand::Left => {
                if let Some(projection) = self.board.take_if(|p| p.is_closed()) {
                    info!(
                        builds = projection.builds,
                        sent = projection.sent,
                        "the board's view stopped"
                    );
                }
            }
            BoardCommand::Bindings(bindings) => {
                if let Some(projection) = &mut self.board {
                    projection.bindings(bindings);
                    self.board_tick();
                }
            }
            BoardCommand::Read { key, device, reply } => {
                let answer = match self.model.newest_message(&key) {
                    Err(refused) => Err(refused),
                    Ok(None) => Ok(()),
                    Ok(Some((message, at))) => {
                        self.model.read(&key, &device, &message, at).map(|changes| {
                            self.publish_all(changes);
                        })
                    }
                };
                let _ = reply.send(answer);
            }
            BoardCommand::Holds { what, reply } => {
                let holds = match what {
                    board::Holds::Thread(key) => self.model.newest_message(&key).is_ok(),
                    board::Holds::Machine(name) => {
                        self.board.as_ref().is_none_or(|p| p.shows_machine(&name))
                    }
                };
                let _ = reply.send(holds);
            }
            BoardCommand::Ask { agent, id, reply } => {
                let _ = reply.send(self.model.neutral_ask(&agent, &id));
            }
        }
    }

    /// builds the board's view when it is due, and lets the projection go
    /// once no stream holds it.
    fn board_tick(&mut self) {
        let Some(projection) = &mut self.board else {
            return;
        };
        if projection.is_closed() {
            self.board = None;
            info!("the board's view stopped: no stream held it");
            return;
        }
        let now = board::Clock::now();
        if let Some(built) = projection.tick(&self.model, now)
            && projection.sample(now.at)
        {
            self.outside.telemetry.record(&json!({
                "kind": "perf.board_view",
                "ms": built.micros / 1000,
                "props": { "us": built.micros, "bytes": built.bytes, "threads": built.threads },
            }));
        }
    }

    /// queues a window's tail read; one that cannot wait leaves the session
    /// to be asked again on its next change.
    fn ask_tail(&mut self, request: TailRequest) {
        if request.newest {
            // a re-read that cannot be asked resets the thread instead: no streamed text is lost
            if let Err(
                mpsc::error::TrySendError::Full(request)
                | mpsc::error::TrySendError::Closed(request),
            ) = self.tails.try_send(request)
            {
                warn!(
                    session = request.key,
                    "a thread's newest messages cannot be asked for; it is reset"
                );
                self.unasked.push(request.key);
            }
            return;
        }
        match self.tails.try_send(request) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(request)) => {
                warn!(
                    session = request.key,
                    cap = TAIL_REQUESTS,
                    "the tail reader is behind; this window's tail is asked again on its next change"
                );
                self.model.tail_not_asked(&request.key);
            }
            // the reader has stopped: the server is going down
            Err(mpsc::error::TrySendError::Closed(request)) => {
                self.model.tail_not_asked(&request.key);
            }
        }
    }

    /// one model change as the journal entries the encoder gives for it: a
    /// thread as a patch against its last state (or nothing), the order as
    /// ops, a delta into its batch, a part without the text its deltas
    /// built; every one that is not a delta takes the pending deltas first.
    fn encode(&mut self, now: i64, change: Change) -> Vec<Change> {
        let encoder = &mut self.encoder;
        match change {
            Change::Thread { thread } => encoder.thread(thread),
            Change::ThreadRemoved { key } => encoder.thread_removed(&key),
            Change::ThreadReset { key } => encoder.thread_reset(&key),
            Change::Order { keys } => encoder.order(keys),
            Change::Message {
                key,
                upstream,
                message,
            } => encoder.message(&key, upstream, message),
            Change::MessageRemoved {
                key,
                upstream,
                message_id,
            } => encoder.message_removed(&key, upstream, message_id),
            Change::Part {
                key,
                upstream,
                part,
            } => encoder.part(&key, upstream, part),
            Change::Delta {
                key,
                message_id,
                part_id,
                field,
                delta,
                offset,
            } => encoder.delta(now, &key, &message_id, &part_id, &field, &delta, offset),
            Change::Btw { key, upstream, btw } => encoder.btw(&key, upstream, btw),
            // the model leaves the offset to the encoder, which counts it
            Change::BtwDelta {
                key, btw_id, delta, ..
            } => encoder.btw_delta(now, &key, &btw_id, &delta),
            other => encoder.other(other),
        }
    }

    fn journal_all(&mut self, entries: Vec<Change>) {
        for change in entries {
            self.publish(&change);
        }
    }

    /// appends one entry to the journal, encoded once, and hands its bytes
    /// to every live stream.
    fn publish(&mut self, change: &Change) {
        let thread = change.transcript_key();
        let frame = self.journal.append_for(thread, |seq| {
            match serde_json::to_vec(&EntryRef { seq, change }) {
                Ok(json) => Some(json),
                Err(e) => {
                    error!(error = %e, "a change did not serialize; it is not journaled");
                    None
                }
            }
        });
        let Some(frame) = frame else { return };
        self.keys.saw(self.journal.head(), change, crate::now_ms());
        if let Some(key) = persist::key_of(change) {
            self.persist.mark(key);
        }
        self.deliver(&frame, thread);
    }

    /// a repo colour for every stream: id-less, outside the journal, queued
    /// ahead of whatever the step journals next.
    fn colour(&mut self, colour: RepoColour) {
        match serde_json::to_vec(&ColourFrame::Colour { colour }) {
            Ok(json) => self.deliver(&sse_frame(None, &json), None),
            Err(e) => error!(error = %e, "a repo colour did not serialize; it is not sent"),
        }
    }

    /// the whole colour map, as every stream gets it first.
    fn colour_map(&self) -> Option<Bytes> {
        let frame = ColourFrame::Colours {
            colours: self.model.colour_list(),
        };
        match serde_json::to_vec(&frame) {
            Ok(json) => Some(sse_frame(None, &json)),
            Err(e) => {
                error!(error = %e, "the repo colours did not serialize; they are not sent");
                None
            }
        }
    }

    /// hands a frame to every stream that takes it (an overview frame or a
    /// colour: all; a transcript entry: those whose interest holds its
    /// thread), closing any that fell past the cap.
    fn deliver(&mut self, frame: &Bytes, thread: Option<&str>) {
        self.live.retain(|s| {
            if thread.is_some_and(|key| !s.keys.contains(key)) {
                return true;
            }
            let queued = s.queued.load(Ordering::Acquire);
            if queued + frame.len() > OUTBOUND_CAP {
                warn!(stream = %format_args!("{:08x}", s.log), queued_bytes = queued, frame_bytes = frame.len(), cap_bytes = OUTBOUND_CAP, "the client fell 512 KB behind; closing its stream");
                s.closed.cancel();
                return false;
            }
            s.queued.fetch_add(frame.len(), Ordering::AcqRel);
            // a failed send means the stream is gone: it leaves the map
            s.frames.send(Feed::Frame(frame.clone())).is_ok()
        });
    }

    /// the fleet as the journal has told it: what a reset carries and
    /// `GET /api/fleet` answers. each thread and the order are their last
    /// journaled state (the encoder's bases), so the patches after it apply
    /// to exactly what the client holds, whatever the model holds back for
    /// the pace.
    fn journaled(&self) -> crate::wire::Fleet {
        let mut fleet = self.model.snapshot();
        for thread in &mut fleet.threads {
            if let Some(base) = self.encoder.base(&thread.key) {
                thread.clone_from(base);
            }
        }
        if let Some(order) = self.encoder.order_base() {
            fleet.order = order.to_vec();
        }
        fleet
    }

    /// a client stream opens: `hello` and the colour map, then a `reset`
    /// when its cursor cannot be caught up, else the compact catch-up from
    /// it, ending in `caught`; then it is live with the interest it declared.
    fn open(&mut self, opening: &Opening) -> Opened {
        let id = rand::random::<u128>();
        let mut frames = Vec::new();
        frames.extend(self.hello(id, &opening.interest));
        frames.extend(self.colour_map());
        let head = self.journal.head();
        let reason = match &opening.from {
            From::Start => Some(ResetReason::None),
            From::Malformed => Some(ResetReason::Invalid),
            From::At(cursor) if cursor.epoch != self.journal.epoch() => Some(ResetReason::Epoch),
            From::At(cursor) if cursor.seq > head => Some(ResetReason::Invalid),
            From::At(cursor) if cursor.seq < self.keys.gone_floor() => Some(ResetReason::Expired),
            From::At(_) => None,
        };
        match (reason, &opening.from) {
            (Some(reason), _) => frames.extend(self.reset(reason, opening.log)),
            (None, From::At(cursor)) => {
                let caught = self.catch_up(cursor.seq, &opening.interest, &opening.since);
                info!(stream = %format_args!("{:08x}", opening.log), from = cursor.seq, head, frames = caught.len(), bytes = caught.iter().map(Bytes::len).sum::<usize>(), "stream catches up from its cursor");
                frames.extend(caught);
            }
            (None, _) => {}
        }
        let live = self.subscribe(id, opening);
        Opened {
            frames,
            live,
            stream: id,
        }
    }

    fn reset(&self, reason: ResetReason, log: u32) -> Option<Bytes> {
        let head = self.journal.head();
        let control = Control::Reset {
            seq: head,
            epoch: self.journal.epoch().to_owned(),
            reason,
            fleet: self.journaled(),
        };
        let frame = self.control_frame(Some(head), &control)?;
        info!(stream = %format_args!("{log:08x}"), reason = reason.as_str(), head, bytes = frame.len(), "stream starts from a snapshot");
        Some(frame)
    }

    /// an entry frame with its own id.
    fn entry_frame(&self, seq: u64, change: &Change) -> Option<Bytes> {
        match serde_json::to_vec(&EntryRef { seq, change }) {
            Ok(json) => Some(sse_frame(Some(&self.cursor(seq).to_string()), &json)),
            Err(e) => {
                error!(error = %e, "a catch-up entry did not serialize; it is not sent");
                None
            }
        }
    }

    fn control_frame(&self, id: Option<u64>, control: &Control) -> Option<Bytes> {
        match serde_json::to_vec(control) {
            Ok(json) => Some(sse_frame(
                id.map(|seq| self.cursor(seq).to_string()).as_deref(),
                &json,
            )),
            Err(e) => {
                error!(error = %e, "a control frame did not serialize; it is not sent");
                None
            }
        }
    }

    /// the compact catch-up from `cursor` (`docs/protocol.md`, section 9):
    /// the overview that moved after it, each frame with the id of its
    /// newest entry and in seq order; then per interest key with a `since`
    /// its compacted transcript in `catchup` frames, or `thread.stale`; then
    /// `caught` at the head.
    fn catch_up(
        &self,
        cursor: u64,
        interest: &Interest,
        since: &BTreeMap<String, u64>,
    ) -> Vec<Bytes> {
        let moved = self.keys.since(cursor);
        let mut entries = moved.entries;
        for (seq, key) in moved.threads {
            if let Some(thread) = self.encoder.base(&key) {
                entries.push((
                    seq,
                    Change::Thread {
                        thread: thread.clone(),
                    },
                ));
            }
        }
        if let (Some(seq), Some(order)) = (moved.order, self.encoder.order_base()) {
            entries.push((
                seq,
                Change::Order {
                    keys: order.to_vec(),
                },
            ));
        }
        entries.sort_by_key(|(seq, _)| *seq);
        let mut frames: Vec<Bytes> = entries
            .iter()
            .filter_map(|(seq, change)| self.entry_frame(*seq, change))
            .collect();
        let caught = self.catch_keys(
            interest_keys(interest)
                .into_iter()
                .filter_map(|key| since.get(&key).map(|&seq| (key, seq))),
        );
        frames.extend(caught.frames);
        // a key reset after its `since` and after the cursor has its
        // `thread.reset` above; one reset at or below the cursor reached the
        // stream live, and is stale here, so the client reads it before it
        // trusts it
        let reset_before = caught
            .reset
            .into_iter()
            .filter(|key| self.keys.thread(key).is_none_or(|t| t.reset_seq <= cursor));
        for key in caught.stale.into_iter().chain(reset_before) {
            frames.extend(self.control_frame(None, &Control::ThreadStale { key }));
        }
        let head = self.journal.head();
        frames.extend(self.control_frame(Some(head), &Control::Caught { seq: head }));
        frames
    }

    /// one key's catch-up from its `since`.
    fn key_catch(&self, key: &str, since: u64) -> KeyCatch {
        let Some(thread) = self.keys.thread(key) else {
            return KeyCatch::Stale;
        };
        if thread.reset_seq > since {
            return KeyCatch::Reset;
        }
        // nothing of its transcript after `since`: true from the ring or from a restart's empty one
        if thread.v <= since {
            return KeyCatch::Entries(Vec::new());
        }
        let Ok(held) = self.journal.transcript(key, since) else {
            return KeyCatch::Stale;
        };
        let mut entries = Vec::with_capacity(held.len());
        for (_, frame) in held {
            match serde_json::from_slice::<JournalEntry>(&frame_data(&frame)) {
                Ok(entry) => entries.push(entry),
                Err(e) => {
                    error!(error = %e, thread = key, "a journaled entry did not decode; the thread is caught up by a read");
                    return KeyCatch::Stale;
                }
            }
        }
        KeyCatch::Entries(catchup::compact(entries))
    }

    /// keys with their `since`, caught up in order within one block's cap:
    /// a key whose catch-up would pass it, or one entry alone a frame's, is
    /// stale and read by the client.
    fn catch_keys(&self, keys: impl Iterator<Item = (String, u64)>) -> Caught {
        let mut caught = Caught::default();
        let mut total = 0;
        for (key, since) in keys {
            match self.key_catch(&key, since) {
                KeyCatch::Reset => caught.reset.push(key),
                KeyCatch::Stale => caught.stale.push(key),
                KeyCatch::Entries(entries) if entries.is_empty() => {}
                KeyCatch::Entries(entries) => match catchup::frames(&entries) {
                    Some(frames) => {
                        let bytes: usize = frames.iter().map(Bytes::len).sum();
                        if total + bytes > catchup::BLOCK_BYTES {
                            caught.stale.push(key);
                        } else {
                            total += bytes;
                            caught.frames.extend(frames);
                        }
                    }
                    None => caught.stale.push(key),
                },
            }
        }
        caught
    }

    /// an interest post (`docs/protocol.md`, section 5): at the head H the
    /// stream's filter swaps, and its confirm block (the catch-up of every key
    /// that enters with a `since`, then the `interest` frame with id H) goes
    /// on its channel behind what is queued.
    fn interest(&mut self, stream: u128, owner: Owner, post: &InterestPost) -> Confirm {
        let Some(at) = self.live.iter().position(|s| s.id == stream) else {
            return Confirm::NoSuchStream;
        };
        let s = &self.live[at];
        if s.frames.is_closed() || s.closed.is_cancelled() {
            self.live.remove(at);
            return Confirm::NoSuchStream;
        }
        if s.owner != owner {
            return Confirm::NoSuchStream;
        }
        if post.ask <= s.asked {
            return Confirm::Older;
        }
        if let Some(block) = s.block.as_ref().filter(|b| !b.drained.is_cancelled()) {
            return Confirm::Busy {
                drained: block.drained.clone(),
                closed: s.closed.clone(),
                handed: block.handed,
                ask: block.ask,
            };
        }
        let interest = Interest {
            thread: post.thread.clone(),
            under: post.under.clone(),
            holds: post.holds.clone(),
        };
        let keys = interest_keys(&interest);
        let entering: Vec<(String, u64)> = keys
            .iter()
            .filter(|key| !s.keys.contains(*key))
            .filter_map(|key| post.since.get(key).map(|&seq| (key.clone(), seq)))
            .collect();
        let entered = entering.len();
        let caught = self.catch_keys(entering.into_iter());
        let head = self.journal.head();
        let mut frames = caught.frames;
        let (stale, reset) = (caught.stale.len(), caught.reset.len());
        let catchup_bytes: usize = frames.iter().map(Bytes::len).sum();
        frames.extend(self.control_frame(
            Some(head),
            &Control::Interest {
                ask: post.ask,
                thread: interest.thread.clone(),
                under: interest.under.clone(),
                holds: interest.holds.clone(),
                seq: head,
                stale: caught.stale,
                reset: caught.reset,
            },
        ));
        let drained = CancellationToken::new();
        let s = &mut self.live[at];
        tracing::debug!(stream = %format_args!("{:08x}", s.log), ask = post.ask, head, entering = entered, catchup_bytes, stale, reset, "interest swapped");
        s.keys = keys.into_iter().collect();
        s.interest = interest;
        s.asked = post.ask;
        s.block = Some(Block {
            drained: drained.clone(),
            handed: tokio::time::Instant::now(),
            ask: post.ask,
        });
        if s.frames.send(Feed::Block { frames, drained }).is_err() {
            self.live.remove(at);
            return Confirm::NoSuchStream;
        }
        Confirm::Applied
    }

    /// the first frame of a stream, with the stream's own id (128 random
    /// bits, what its interest posts name) and the interest it opened with.
    fn hello(&self, id: u128, interest: &Interest) -> Option<Bytes> {
        let hello = Control::Hello {
            protocol: PROTOCOL,
            epoch: self.journal.epoch().to_owned(),
            head: self.journal.head(),
            build: self.build.clone(),
            stream: format!("{id:032x}"),
            interest: interest.clone(),
        };
        self.control_frame(None, &hello)
    }

    fn subscribe(&mut self, id: u128, opening: &Opening) -> Live {
        let (tx, frames) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let closed = CancellationToken::new();
        self.live.push(Subscriber {
            id,
            log: opening.log,
            owner: opening.owner,
            keys: interest_keys(&opening.interest).into_iter().collect(),
            interest: opening.interest.clone(),
            asked: 0,
            frames: tx,
            queued: Arc::clone(&queued),
            closed: closed.clone(),
            block: None,
        });
        Live {
            frames,
            queued,
            closed,
        }
    }

    fn cursor(&self, seq: u64) -> Cursor {
        Cursor {
            epoch: self.journal.epoch().to_owned(),
            seq,
        }
    }
}

impl Outside {
    fn effect(&mut self, effect: Effect) {
        match effect {
            Effect::Need(Moved::Raised(need)) => {
                info!(
                    id = need.id,
                    need = need.kind.as_str(),
                    session = need.key,
                    "need raised"
                );
                self.telemetry.record(&json!({
                    "kind": "need.raised",
                    "host": host_of(&need.key),
                    "session": need.key,
                    "props": { "need": need.kind.as_str(), "child": 0, "id": need.id },
                }));
                self.persist(Persist::Need(need));
            }
            Effect::Need(Moved::Served(need)) => {
                let (Some(by), Some(how), Some(at)) = (&need.served_by, need.how, need.served_at)
                else {
                    return;
                };
                let age = at - need.raised_at;
                info!(
                    id = need.id,
                    need = need.kind.as_str(),
                    session = need.key,
                    by = by.label(),
                    how = how.as_str(),
                    age_ms = age,
                    "need served"
                );
                if by.is_person() {
                    self.telemetry.record(&json!({
                        "kind": "need.served",
                        "host": host_of(&need.key),
                        "session": need.key,
                        "ms": age,
                        "props": { "need": need.kind.as_str(), "by": by.label(), "how": how.as_str(), "id": need.id },
                    }));
                    self.push
                        .served(need.id.clone(), by.label().to_owned(), how.as_str());
                } else {
                    let cleared = if how == needs::How::Expired {
                        "expired"
                    } else {
                        "agent"
                    };
                    self.telemetry.record(&json!({
                        "kind": "need.cleared",
                        "host": host_of(&need.key),
                        "session": need.key,
                        "props": { "need": need.kind.as_str(), "by": cleared, "ageMs": age },
                    }));
                }
                self.persist(Persist::Need(need));
            }
            Effect::Notice(notice) => self.push.notify(notice),
            Effect::Continued(key) => {
                if let Some(thread) = Thread::parse(&key) {
                    self.push.continued(thread);
                }
            }
            Effect::Read { key, mark, source } => {
                self.telemetry.record(&json!({
                    "kind": "read.mark",
                    "host": host_of(&key),
                    "session": key,
                    "props": { "scope": "one", "source": source, "device": mark.device },
                }));
                self.persist(Persist::Read { key, mark });
            }
            Effect::ReadForgotten(key) => self.persist(Persist::Forget(key)),
            Effect::Cleared { key, clear } => self.persist(Persist::Clear { key, clear }),
            Effect::Uncleared(key) => self.persist(Persist::Unclear(key)),
            Effect::Adopted { key, info } => self.persist(Persist::Adopt {
                key,
                info: info.get().to_owned(),
                at: crate::now_ms(),
            }),
            Effect::Unadopted(key) => self.persist(Persist::Unadopt(key)),
            Effect::Colour(write) => {
                let ack = matches!(write, colours::Write::Put { .. })
                    .then(|| self.ack.take())
                    .flatten();
                self.persist(Persist::Colour(write, ack));
            }
            // the actor carries these out itself (`Actor::ask_tail`)
            Effect::ReadTail(_) => {}
        }
    }

    fn persist(&self, write: Persist) {
        if let Err(error) = self.persist.try_send(write) {
            warn!(%error, "the store is not keeping up with the fleet; a write was dropped");
        }
    }
}

/// one journal entry as the wire spells it (`wire::JournalEntry`), its
/// change borrowed: encoded once, never cloned for it.
#[derive(Serialize)]
struct EntryRef<'a> {
    seq: u64,
    #[serde(flatten)]
    change: &'a Change,
}

/// how long until `due`, ms since the epoch; nothing when it has passed.
fn until(due: Option<i64>) -> Duration {
    let wait = due.map_or(0, |due| due - crate::now_ms());
    Duration::from_millis(u64::try_from(wait).unwrap_or(0))
}

fn host_of(key: &str) -> &str {
    key.split_once(':').map_or(key, |(host, _)| host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream::{Connection, FrameCounts, HostStatus};

    fn actor() -> Actor {
        Actor {
            model: Model::new(),
            journal: Journal::new("ep".into()),
            encoder: Encoder::new(),
            keys: StreamKeys::new(),
            live: Vec::new(),
            board: None,
            build: "test".into(),
            tails: mpsc::channel(1).0,
            outside: Outside {
                push: Push::detached(),
                telemetry: crate::telemetry::Sender::detached(),
                persist: mpsc::channel(1).0,
                ack: None,
            },
            persist: persist::Persist::detached(),
            cursors: std::collections::HashMap::new(),
            unasked: Vec::new(),
        }
    }

    /// the host's status, as the cmx2 source sends it.
    fn host(connects: u64) -> Upstream {
        let name: Arc<str> = Arc::from("desk");
        let status = HostStatus {
            name: "desk".into(),
            url: "http://127.0.0.1:4840/".into(),
            origin: crate::config::Origin::Config,
            memory: None,
            system: None,
            reports_system: None,
            connection: Connection::Connected,
            since: 0,
            health: None,
            last_error: None,
            connects,
            frames: FrameCounts::default(),
            cursor: None,
        };
        Upstream::Source {
            connection: Arc::clone(&name),
            agent: name,
            seq: None,
            event: SourceEvent::Connection(translate::connection(status)),
        }
    }

    fn text(frame: &Bytes) -> &str {
        std::str::from_utf8(frame).unwrap()
    }

    fn cursor(seq: u64) -> From {
        From::At(Cursor {
            epoch: "ep".into(),
            seq,
        })
    }

    fn open_with(
        actor: &mut Actor,
        from: From,
        interest: Interest,
        since: &[(&str, u64)],
    ) -> Opened {
        actor.open(&Opening {
            from,
            interest,
            since: since.iter().map(|(k, s)| ((*k).to_owned(), *s)).collect(),
            owner: [1; 32],
            log: 1,
        })
    }

    fn open(actor: &mut Actor, from: From) -> Opened {
        open_with(actor, from, Interest::default(), &[])
    }

    fn showing(thread: &str) -> Interest {
        Interest {
            thread: Some(thread.into()),
            under: Vec::new(),
            holds: Vec::new(),
        }
    }

    fn post(ask: u64, thread: Option<&str>, since: &[(&str, u64)]) -> InterestPost {
        InterestPost {
            ask,
            thread: thread.map(Into::into),
            under: Vec::new(),
            holds: Vec::new(),
            since: since.iter().map(|(k, s)| ((*k).to_owned(), *s)).collect(),
        }
    }

    #[test]
    fn a_first_connection_gets_hello_then_a_snapshot_and_goes_live() {
        let mut actor = actor();
        actor.upstream(host(1));
        let opened = open(&mut actor, From::Start);
        assert_eq!(kinds(&opened.frames), ["hello", "colours", "reset"]);
        assert!(
            text(&opened.frames[0]).starts_with(
                "data: {\"type\":\"hello\",\"protocol\":3,\"epoch\":\"ep\",\"head\":1"
            )
        );
        assert!(text(&opened.frames[2]).starts_with(
            "id: ep:1\ndata: {\"type\":\"reset\",\"seq\":1,\"epoch\":\"ep\",\"reason\":\"none\""
        ));
        let mut live = opened.live;
        actor.upstream(host(2));
        let next = drained(&mut live);
        assert!(text(&next[0]).starts_with("id: ep:2\ndata: {\"seq\":2,\"type\":\"agent\""));
        assert_eq!(live.queued.load(Ordering::Acquire), 0, "taken");
    }

    #[test]
    fn every_stream_gets_its_own_id_and_the_interest_it_opened_with() {
        let mut actor = actor();
        let hello = |frames: &[Bytes]| -> serde_json::Value {
            let data = text(&frames[0]).strip_prefix("data: ").unwrap();
            serde_json::from_str(data.trim_end()).unwrap()
        };
        let one = open(&mut actor, From::Start);
        let two = open_with(&mut actor, From::Start, showing("desk:ses_1"), &[]);
        let (one, two_id) = (hello(&one.frames), two.stream);
        let two = hello(&two.frames);
        let id = one["stream"].as_str().unwrap();
        assert_eq!(id.len(), 32);
        assert!(
            id.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_ne!(one["stream"], two["stream"]);
        assert_eq!(two["stream"], format!("{two_id:032x}"));
        assert_eq!(
            one["interest"],
            serde_json::json!({"thread": null, "under": [], "holds": []})
        );
        assert_eq!(two["interest"]["thread"], "desk:ses_1");
    }

    /// a streamed delta for `thread`, as the cmx2 source sends one.
    fn delta_in(thread: &str, text: &str, offset: u64) -> Upstream {
        Upstream::Source {
            connection: Arc::from("desk"),
            agent: Arc::from("desk"),
            seq: None,
            event: SourceEvent::Delta {
                thread: thread.into(),
                message: "msg_1".into(),
                part: "prt_1".into(),
                field: "text".into(),
                delta: text.into(),
                offset,
            },
        }
    }

    fn delta(text: &str, offset: u64) -> Upstream {
        delta_in("ses_1", text, offset)
    }

    #[test]
    fn deltas_wait_for_their_batch_and_any_other_entry_takes_them_out_first() {
        let mut actor = actor();
        crate::test_clock::set(Some(1_000));
        actor.upstream(delta("hel", 0));
        actor.upstream(delta("lo", 3));
        assert_eq!(actor.journal.head(), 0, "held for its 100 ms");
        assert_eq!(actor.encoder.due(), Some(1_000 + encode::DELTA_EVERY_MS));
        crate::test_clock::set(Some(1_100));
        actor.flush_deltas();
        let frames = actor.journal.page(0, usize::MAX).unwrap().frames;
        assert_eq!(kinds(&frames), ["delta"]);
        assert!(text(&frames[0]).contains(r#""delta":"hello","offset":0"#));
        // a delta pending when the host's status moves goes ahead of it
        actor.upstream(delta(" there", 5));
        actor.upstream(host(1));
        let frames = actor.journal.page(1, usize::MAX).unwrap().frames;
        assert_eq!(kinds(&frames), ["delta", "agent"]);
        crate::test_clock::set(None);
    }

    #[tokio::test]
    async fn a_clean_stop_journals_the_text_still_waiting_for_its_batch() {
        let mut actor = actor();
        let mut live = open_with(&mut actor, From::Start, showing("desk:ses_1"), &[]).live;
        actor.upstream(delta("bye", 0));
        let (_upstream, events) = mpsc::channel(1);
        let (_commands, commands) = mpsc::channel(1);
        let (_looking, looking) = watch::channel(Vec::new());
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        let (_acks, acks) = mpsc::channel(1);
        actor.run(events, commands, acks, looking, shutdown).await;
        let frames = drained(&mut live);
        assert_eq!(kinds(&frames), ["delta"]);
    }

    #[test]
    fn an_agent_that_did_not_change_is_not_journaled_again() {
        let mut actor = actor();
        actor.upstream(host(1));
        actor.upstream(host(1));
        assert_eq!(actor.journal.head(), 1);
    }

    #[test]
    fn a_resume_sends_each_key_that_moved_after_the_cursor_once_whole_then_caught() {
        let mut actor = actor();
        for n in 1..=3 {
            actor.upstream(host(n));
        }
        let opened = open(&mut actor, cursor(1));
        let ids: Vec<&str> = opened
            .frames
            .iter()
            .skip(2)
            .map(|f| text(f).lines().next().unwrap())
            .collect();
        assert_eq!(
            ids,
            ["id: ep:3", "id: ep:3"],
            "the agent at its newest, then caught"
        );
        assert_eq!(kinds(&opened.frames)[2..], ["agent", "caught"]);
        // at the head: hello, the map, caught
        let at_head = open(&mut actor, cursor(3));
        assert_eq!(kinds(&at_head.frames), ["hello", "colours", "caught"]);
    }

    #[test]
    fn a_cursor_from_another_epoch_past_the_head_or_below_the_tombstone_floor_starts_from_a_snapshot()
     {
        let mut actor = actor();
        actor.upstream(host(1));
        for n in 0..(keys::GONE_ROWS as u64 + 2) {
            actor.keys.saw(
                n + 2,
                &Change::ThreadRemoved {
                    key: format!("desk:{n}"),
                },
                0,
            );
        }
        assert!(actor.keys.gone_floor() > 1);
        for (from, reason) in [
            (
                From::At(Cursor {
                    epoch: "old".into(),
                    seq: 1,
                }),
                "epoch",
            ),
            (cursor(9), "invalid"),
            (From::Malformed, "invalid"),
            (cursor(1), "expired"),
        ] {
            let opened = open(&mut actor, from);
            assert!(
                text(opened.frames.last().unwrap()).contains(&format!("\"reason\":\"{reason}\"")),
                "{reason}"
            );
        }
    }

    #[test]
    fn a_stream_that_falls_past_the_cap_is_closed_and_dropped() {
        let mut actor = actor();
        let live = open(&mut actor, From::Start).live;
        // nobody takes from the queue: it fills until the cap closes it
        for n in 0..10_000 {
            actor.upstream(host(n));
            if live.closed.is_cancelled() {
                break;
            }
        }
        assert!(live.closed.is_cancelled());
        assert!(live.queued.load(Ordering::Acquire) <= OUTBOUND_CAP);
        assert!(actor.live.is_empty());
    }

    #[test]
    fn a_stream_that_went_away_leaves_the_map_on_the_next_frame_or_when_it_says_so() {
        let mut actor = actor();
        drop(open(&mut actor, From::Start).live);
        actor.upstream(host(1));
        assert!(actor.live.is_empty());
        let opened = open(&mut actor, From::Start);
        actor.command(Command::Ended {
            stream: opened.stream,
        });
        assert!(actor.live.is_empty());
    }

    #[test]
    fn a_transcript_entry_reaches_only_the_streams_showing_its_thread_and_the_overview_every_one() {
        let mut actor = actor();
        let mut home = open(&mut actor, From::Start).live;
        let mut one = open_with(&mut actor, From::Start, showing("desk:ses_1"), &[]).live;
        let mut two = open_with(&mut actor, From::Start, showing("desk:ses_2"), &[]).live;
        actor.upstream(delta_in("ses_1", "hi", 0));
        actor.upstream(host(1));
        assert_eq!(kinds(&drained(&mut home)), ["agent"]);
        assert_eq!(kinds(&drained(&mut one)), ["delta", "agent"]);
        assert_eq!(kinds(&drained(&mut two)), ["agent"]);
    }

    #[test]
    fn an_interest_post_swaps_the_filter_at_the_head_and_confirms_behind_what_is_queued() {
        let mut actor = actor();
        actor.upstream(session_in("ses_1", "/w"));
        let opened = open(&mut actor, From::Start);
        let (id, mut live) = (opened.stream, opened.live);
        crate::test_clock::set(Some(1_000));
        actor.upstream(delta("hello", 0));
        actor.upstream(host(1));
        let since = actor.journal.head() - 2;
        actor.upstream(delta(" world", 5));
        actor.upstream(host(2));
        crate::test_clock::set(None);
        let head = actor.journal.head();
        // home did not get the deltas; it posts the thread with its `left`
        assert!(matches!(
            actor.interest(
                id,
                [1; 32],
                &post(1, Some("desk:ses_1"), &[("desk:ses_1", since)])
            ),
            Confirm::Applied
        ));
        let frames = drained(&mut live);
        assert_eq!(kinds(&frames), ["agent", "agent", "catchup", "interest"]);
        let catchup = text(&frames[2]);
        assert!(!catchup.starts_with("id:"), "id-less");
        assert!(
            catchup.contains(r#""delta":"hello world","offset":0"#),
            "merged: {catchup}"
        );
        assert!(text(&frames[3]).starts_with(&format!("id: ep:{head}\n")));
        assert!(text(&frames[3]).contains(r#""ask":1,"thread":"desk:ses_1""#));
        // from here its words reach it
        actor.upstream(delta("!", 11));
        actor.flush_deltas_now();
        assert_eq!(kinds(&drained(&mut live)), ["delta"]);
        // an older ask is taken and not confirmed; another session's is no stream
        assert!(matches!(
            actor.interest(id, [1; 32], &post(1, None, &[])),
            Confirm::Older
        ));
        assert!(matches!(
            actor.interest(id, [2; 32], &post(9, None, &[])),
            Confirm::NoSuchStream
        ));
        assert!(drained(&mut live).is_empty());
    }

    #[test]
    fn a_post_waits_while_the_last_confirm_is_unread_and_a_stall_closes_the_stream() {
        let mut actor = actor();
        let opened = open(&mut actor, From::Start);
        let (id, mut live) = (opened.stream, opened.live);
        assert!(matches!(
            actor.interest(id, [1; 32], &post(1, Some("desk:ses_1"), &[])),
            Confirm::Applied
        ));
        let Confirm::Busy {
            drained: unread, ..
        } = actor.interest(id, [1; 32], &post(2, None, &[]))
        else {
            panic!("the first confirm is unread")
        };
        // the stream takes its block: the next post goes through
        let Ok(Feed::Block { drained: block, .. }) = live.frames.try_recv() else {
            panic!("a block")
        };
        block.cancel();
        assert!(unread.is_cancelled());
        assert!(matches!(
            actor.interest(id, [1; 32], &post(2, None, &[])),
            Confirm::Applied
        ));
        // a post that waited out its 30 s closes the stream, and it is gone
        actor.command(Command::Stalled { stream: id, ask: 2 });
        assert!(live.closed.is_cancelled());
        assert!(matches!(
            actor.interest(id, [1; 32], &post(3, None, &[])),
            Confirm::NoSuchStream
        ));
    }

    #[test]
    fn a_stall_that_meets_a_drained_block_leaves_the_stream_open() {
        let mut actor = actor();
        let opened = open(&mut actor, From::Start);
        let (id, mut live) = (opened.stream, opened.live);
        assert!(matches!(
            actor.interest(id, [1; 32], &post(1, Some("desk:ses_1"), &[])),
            Confirm::Applied
        ));
        // the stream drains its block just as a waiting post's 30 s run out
        assert!(!drained(&mut live).is_empty());
        actor.command(Command::Stalled { stream: id, ask: 1 });
        assert!(!live.closed.is_cancelled(), "a read stream was closed");
        assert!(matches!(
            actor.interest(id, [1; 32], &post(2, None, &[])),
            Confirm::Applied
        ));
    }

    #[test]
    fn a_resume_catches_up_the_threads_it_shows_from_their_since_and_marks_a_reset_one_stale() {
        let mut actor = actor();
        actor.upstream(session_in("ses_1", "/w"));
        let at = actor.journal.head();
        crate::test_clock::set(Some(1_000));
        actor.upstream(delta("hello", 0));
        crate::test_clock::set(None);
        actor.flush_deltas_now();
        let opened = open_with(
            &mut actor,
            cursor(at),
            showing("desk:ses_1"),
            &[("desk:ses_1", at)],
        );
        assert_eq!(kinds(&opened.frames)[2..], ["catchup", "caught"]);
        // reset at or below the cursor: the stream heard it live; stale here
        actor.publish(&Change::ThreadReset {
            key: "desk:ses_1".into(),
        });
        let head = actor.journal.head();
        let opened = open_with(
            &mut actor,
            cursor(head),
            showing("desk:ses_1"),
            &[("desk:ses_1", at)],
        );
        assert_eq!(kinds(&opened.frames)[2..], ["thread.stale", "caught"]);
        // above the cursor: the overview carries the reset, and nothing more
        let opened = open_with(
            &mut actor,
            cursor(head - 1),
            showing("desk:ses_1"),
            &[("desk:ses_1", at)],
        );
        assert_eq!(kinds(&opened.frames)[2..], ["thread.reset", "caught"]);
    }

    #[test]
    fn versions_follow_the_thread_s_transcript() {
        let mut actor = actor();
        actor.upstream(session_in("ses_1", "/w"));
        let seen = actor.keys.thread("desk:ses_1").unwrap().seq;
        let (reply, mut answer) = oneshot::channel();
        actor.command(Command::Versions {
            key: "desk:ses_1".into(),
            reply,
        });
        let versions = answer.try_recv().unwrap();
        assert_eq!((versions.v, versions.rv), (Some(seen), Some(seen)));
        assert_eq!(versions.encoder, ENCODER);
        assert_eq!(
            versions.at.to_string(),
            format!("ep:{}", actor.journal.head())
        );
        crate::test_clock::set(Some(1_000));
        actor.upstream(delta("hi", 0));
        crate::test_clock::set(None);
        actor.flush_deltas_now();
        let (reply, mut answer) = oneshot::channel();
        actor.command(Command::Versions {
            key: "desk:ses_1".into(),
            reply,
        });
        assert_eq!(answer.try_recv().unwrap().v, Some(actor.journal.head()));
        let (reply, mut answer) = oneshot::channel();
        actor.command(Command::Versions {
            key: "desk:nope".into(),
            reply,
        });
        assert_eq!(answer.try_recv().unwrap().v, None);
    }

    impl Actor {
        /// every pending delta journaled now.
        fn flush_deltas_now(&mut self) {
            let pending = self.encoder.flush();
            self.journal_all(pending);
        }
    }

    /// an actor on a fresh install, which gives repos colours, and where its
    /// writes go.
    fn colouring() -> (Actor, mpsc::Receiver<Persist>) {
        let (persist, written) = mpsc::channel(64);
        let mut actor = actor();
        actor.model = Model::restored(
            Needs::default(),
            Reads::default(),
            Clears::default(),
            Vec::new(),
            Colours::assigning(),
        );
        actor.outside.persist = persist;
        (actor, written)
    }

    /// a session created in `project`, as the cmx2 watcher hands it on.
    fn session_in(id: &str, project: &str) -> Upstream {
        let frame = format!(
            r#"{{"payload":{{"id":"e","type":"session.updated","properties":{{"sessionID":"{id}","info":{{"id":"{id}","slug":"s","projectID":"{project}","directory":"{project}","title":"t","version":"0","source":"cmx2","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":{{"created":1,"updated":2}}}}}}}}}}"#
        );
        let decoded = crate::cmx2::decode_frame(&frame).unwrap();
        let event = translate::event(
            "desk",
            decoded.directory.as_deref(),
            &decoded.event,
            &decoded.payload,
        )
        .unwrap()
        .unwrap();
        Upstream::Source {
            connection: Arc::from("desk"),
            agent: Arc::from("desk"),
            seq: None,
            event,
        }
    }

    fn kinds(frames: &[Bytes]) -> Vec<String> {
        frames
            .iter()
            .map(|f| {
                let data = text(f)
                    .lines()
                    .find_map(|l| l.strip_prefix("data: "))
                    .unwrap();
                let value: serde_json::Value = serde_json::from_str(data).unwrap();
                value["type"].as_str().unwrap().to_owned()
            })
            .collect()
    }

    /// what a stream takes off its feed now, a confirm block as its frames
    /// (and said taken).
    fn drained(live: &mut Live) -> Vec<Bytes> {
        let mut frames = Vec::new();
        while let Ok(feed) = live.frames.try_recv() {
            match feed {
                Feed::Frame(frame) => {
                    live.queued.fetch_sub(frame.len(), Ordering::AcqRel);
                    frames.push(frame);
                }
                Feed::Block {
                    frames: block,
                    drained,
                } => {
                    frames.extend(block);
                    drained.cancel();
                }
            }
        }
        frames
    }

    /// a stream from the start.
    fn coloured_stream(actor: &mut Actor) -> (Vec<Bytes>, Live) {
        let opened = open(actor, From::Start);
        (opened.frames, opened.live)
    }

    fn choose(actor: &mut Actor, colour: Option<&str>) -> Chosen {
        let (reply, mut answer) = oneshot::channel();
        actor.command(Command::ChooseColour {
            host: "desk".into(),
            root: "/work/api".into(),
            chosen: colour.and_then(colours::slot),
            reply,
        });
        answer.try_recv().unwrap().unwrap()
    }

    #[test]
    fn colours_are_outside_the_journal_the_entries_are_the_same_given_or_not() {
        let (mut colouring, _written) = colouring();
        let mut plain = actor();
        let mut ours = open(&mut colouring, From::Start).live;
        let mut theirs = open(&mut plain, From::Start).live;
        for actor in [&mut colouring, &mut plain] {
            actor.upstream(session_in("ses_1", "/work/api"));
            actor.upstream(session_in("ses_2", "/work/web"));
        }
        let _ = choose(&mut colouring, Some("sunset"));
        let entries = |frames: Vec<Bytes>| -> Vec<Bytes> {
            frames
                .into_iter()
                .filter(|f| text(f).starts_with("id:"))
                .collect()
        };
        let (ours, theirs) = (drained(&mut ours), drained(&mut theirs));
        assert!(ours.iter().any(|f| !text(f).starts_with("id:")), "colours");
        let (ours, theirs) = (entries(ours), entries(theirs));
        assert!(!ours.is_empty());
        assert_eq!(ours, theirs, "the same entries, colours given or not");
    }

    #[test]
    fn a_stream_gets_the_map_first_then_each_colour_ahead_of_its_repo_s_first_session() {
        let (mut actor, mut written) = colouring();
        actor.upstream(session_in("ses_0", "/work/old"));
        let (frames, mut live) = coloured_stream(&mut actor);
        assert_eq!(kinds(&frames), ["hello", "colours", "reset"]);
        assert!(text(&frames[1]).starts_with(
            "data: {\"type\":\"colours\",\"colours\":[{\"host\":\"desk\",\"root\":\"/work/old\""
        ));
        actor.upstream(session_in("ses_1", "/work/api"));
        actor.upstream(session_in("ses_2", "/work/api"));
        let frames = drained(&mut live);
        let kinds = kinds(&frames);
        assert_eq!(
            kinds.first().map(String::as_str),
            Some("colour"),
            "{kinds:?}"
        );
        assert_eq!(
            kinds.iter().filter(|k| *k == "colour").count(),
            1,
            "one colour for the repo: {kinds:?}"
        );
        assert!(!text(&frames[0]).starts_with("id:"), "id-less");
        assert!(
            text(&frames[0]).contains(r#""colour":{"host":"desk","root":"/work/api","auto":""#)
        );
        while let Ok(write) = written.try_recv() {
            assert!(
                matches!(write, Persist::Colour(colours::Write::Put { .. }, None)),
                "written at once"
            );
        }
    }

    #[test]
    fn a_resumed_stream_gets_the_whole_map_with_the_repos_that_came_while_it_was_away() {
        let (mut actor, _written) = colouring();
        actor.upstream(session_in("ses_0", "/work/old"));
        let (_, live) = coloured_stream(&mut actor);
        let at = actor.journal.head();
        drop(live);
        // while it was away a new repo came, and its first session with it
        actor.upstream(session_in("ses_1", "/work/api"));
        let opened = open(&mut actor, cursor(at));
        let kinds = kinds(&opened.frames);
        assert_eq!(&kinds[..2], ["hello", "colours"], "{kinds:?}");
        assert!(text(&opened.frames[1]).contains(r#""root":"/work/api""#));
        assert!(kinds[2..].contains(&"thread".to_owned()));
    }
    #[test]
    fn a_choice_reaches_every_stream_and_answers_once_written() {
        let (mut actor, mut written_rows) = colouring();
        actor.upstream(session_in("ses_1", "/work/api"));
        while written_rows.try_recv().is_ok() {}
        let (_, mut phone) = coloured_stream(&mut actor);
        let (_, mut mac) = coloured_stream(&mut actor);
        let Chosen {
            colour,
            mut written,
        } = choose(&mut actor, Some("sunset"));
        assert_eq!(colour.chosen.as_deref(), Some("sunset"));
        for live in [&mut phone, &mut mac] {
            let frames = drained(live);
            assert_eq!(kinds(&frames), ["colour"]);
            assert!(text(&frames[0]).contains(r#""chosen":"sunset""#));
        }
        let Ok(Persist::Colour(_, Some(ack))) = written_rows.try_recv() else {
            panic!("the choice's row carries its acknowledgement to the writer");
        };
        assert!(written.try_recv().is_err(), "not committed yet");
        ack.send(true).unwrap();
        assert_eq!(written.try_recv(), Ok(true));
    }

    #[test]
    fn a_retry_after_a_dropped_write_is_written_and_survives_a_restart() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let (mut actor, mut rows) = colouring();
        actor.upstream(session_in("ses_1", "/work/api"));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let save = |write: colours::Write| {
            runtime
                .block_on(store.call(move |c| colours::save(c, &write)))
                .unwrap();
        };
        while let Ok(Persist::Colour(write, _)) = rows.try_recv() {
            save(write);
        }
        let (_, mut live) = coloured_stream(&mut actor);
        // the choice's write is dropped: no ack, so the answer is 503
        let Chosen { mut written, .. } = choose(&mut actor, Some("sunset"));
        drop(rows.try_recv().unwrap());
        assert!(written.try_recv().is_err(), "never acknowledged");
        assert_eq!(kinds(&drained(&mut live)), ["colour"]);
        // the retry moves nothing, journals and sends nothing, and still writes
        let Chosen {
            colour,
            mut written,
        } = choose(&mut actor, Some("sunset"));
        assert_eq!(colour.chosen.as_deref(), Some("sunset"));
        assert!(
            drained(&mut live).is_empty(),
            "nothing moved, so nothing is sent"
        );
        let Ok(Persist::Colour(write, Some(ack))) = rows.try_recv() else {
            panic!("the retry writes the row, with the acknowledgement");
        };
        save(write);
        ack.send(true).unwrap();
        assert_eq!(written.try_recv(), Ok(true));
        // a restart reads what the table kept
        let kept = runtime.block_on(store.call(|c| colours::load(c))).unwrap();
        let (restored, _) = Colours::restore(kept);
        let api = restored
            .list()
            .into_iter()
            .find(|c| c.root == "/work/api")
            .unwrap();
        assert_eq!(api.chosen.as_deref(), Some("sunset"));
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn read_at(floor: u64) -> Upstream {
        Upstream::Source {
            connection: Arc::from("desk"),
            agent: Arc::from("desk"),
            seq: None,
            event: SourceEvent::Snapshot(Box::new(crate::source::Snapshot {
                epoch: Some("ep".into()),
                floors: crate::source::Floors {
                    threads: floor,
                    activities: floor,
                    permissions: floor,
                    questions: floor,
                },
                threads: Vec::new(),
                activities: Vec::new(),
                asks: Vec::new(),
            })),
        }
    }

    fn sequenced(mut message: Upstream, at: u64) -> Upstream {
        if let Upstream::Source { seq, .. } = &mut message {
            *seq = Some(at);
        }
        message
    }

    fn database() -> rusqlite::Connection {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        connection
    }

    fn written(db: &mut rusqlite::Connection, actor: &mut Actor, batch: &persist::Batch, ok: bool) {
        let result = if ok {
            persist::write(db, batch).map_err(|e| e.to_string())
        } else {
            Err("disk full".into())
        };
        actor.persist.acknowledged(
            &persist::Ack {
                id: batch.id,
                result,
            },
            std::time::Instant::now(),
        );
    }

    fn stored_threads(db: &rusqlite::Connection) -> (u64, Vec<String>) {
        let stored = persist::load(db).unwrap().unwrap();
        let cursor = stored
            .cursors
            .iter()
            .find(|(c, _)| c == "desk")
            .map_or(0, |(_, at)| at.seq);
        let mut threads: Vec<String> = stored
            .rows
            .into_iter()
            .filter(|r| r.kind == "thread")
            .map(|r| r.key)
            .collect();
        threads.sort();
        (cursor, threads)
    }

    #[test]
    fn a_cursor_is_never_written_ahead_of_the_states_it_reflects() {
        let mut actor = actor();
        actor.journal = Journal::new("0123456789ab".into());
        let mut db = database();
        actor.upstream(host(1));
        actor.upstream(read_at(5));
        actor.upstream(sequenced(session_in("ses_1", "/w"), 6));
        let first = actor.take_batch(false);
        // the next event lands while the batch is out
        actor.upstream(sequenced(session_in("ses_2", "/w"), 7));
        written(&mut db, &mut actor, &first, true);
        assert_eq!(stored_threads(&db), (6, vec!["desk:ses_1".to_owned()]));
        let second = actor.take_batch(false);
        written(&mut db, &mut actor, &second, true);
        assert_eq!(
            stored_threads(&db),
            (7, vec!["desk:ses_1".to_owned(), "desk:ses_2".to_owned()])
        );
        // a failed write keeps it all dirty: the next batch carries the cursor with its state
        actor.upstream(sequenced(session_in("ses_3", "/w"), 8));
        let third = actor.take_batch(false);
        written(&mut db, &mut actor, &third, false);
        assert_eq!(stored_threads(&db).0, 7);
        let fourth = actor.take_batch(false);
        assert!(
            fourth
                .writes
                .iter()
                .any(|w| matches!(w, persist::Write::Put(r) if r.key == "desk:ses_3"))
        );
        written(&mut db, &mut actor, &fourth, true);
        assert_eq!(stored_threads(&db).0, 8);
        assert_eq!(stored_threads(&db).1.len(), 3);
        // nothing moved: no batch is due
        assert!(!actor.persist.due(actor.journal.head()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_slow_disk_never_drops_a_batch_and_a_clean_stop_resumes_where_it_stood() {
        let (store, _thread, dir) = crate::store::tests::scratch();
        let shutdown = CancellationToken::new();
        let resumed = persist::resume(&store).await.unwrap();
        assert_eq!(resumed.how, persist::How::Fresh);
        let (_looking_tx, looking) = watch::channel(Vec::new());
        let (fleet, task) = spawn(
            "test".into(),
            Wiring {
                push: Push::detached(),
                telemetry: crate::telemetry::Sender::detached(),
                store: store.clone(),
                looking,
                needs: Needs::default(),
                reads: Reads::default(),
                clears: Clears::default(),
                adopted: Vec::new(),
                colours: Colours::default(),
                tails: mpsc::channel(TAIL_REQUESTS).0,
                resumed,
            },
            shutdown.clone(),
        );
        // the disk stalls: the writer's thread is held 1.5 s at a time while events stream in
        let slow = store.clone();
        let stall = tokio::spawn(async move {
            for _ in 0..4 {
                let _ = slow
                    .call(|_| {
                        std::thread::sleep(Duration::from_millis(1500));
                        Ok(())
                    })
                    .await;
            }
        });
        let upstream = fleet.upstream();
        upstream.send(host(1)).await.unwrap();
        upstream.send(read_at(5)).await.unwrap();
        for n in 0..200u64 {
            upstream
                .send(sequenced(session_in(&format!("ses_{n:03}"), "/w"), 6 + n))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        stall.await.unwrap();
        let (fleet_json, at) = fleet.snapshot().await.unwrap();
        shutdown.cancel();
        task.await.unwrap();
        let resumed = persist::resume(&store).await.unwrap();
        assert_eq!(resumed.how, persist::How::Clean);
        assert_eq!(resumed.head, at.seq, "the head where it stood");
        assert_eq!(resumed.epoch, at.epoch, "the epoch kept");
        assert_eq!(
            resumed.cursors["desk"].seq, 205,
            "the cursor of the last event"
        );
        let mut model = Model::new();
        assert_eq!(model.resume(resumed.model), 0);
        let fleet: crate::wire::Fleet = serde_json::from_slice(&fleet_json).unwrap();
        assert_eq!(model.session_count(), 200);
        assert_eq!(
            serde_json::to_string(&model.snapshot().threads).unwrap(),
            serde_json::to_string(&fleet.threads).unwrap(),
            "every thread as it stood"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
    fn session_cost(id: &str, cost: &str) -> Upstream {
        let frame = format!(
            r#"{{"payload":{{"id":"e","type":"session.updated","properties":{{"sessionID":"{id}","info":{{"id":"{id}","slug":"s","projectID":"/w","directory":"/w","title":"t","version":"0","source":"cmx2","cost":{cost},"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":{{"created":1,"updated":2}}}}}}}}}}"#
        );
        let decoded = crate::cmx2::decode_frame(&frame).unwrap();
        let event = translate::event(
            "desk",
            decoded.directory.as_deref(),
            &decoded.event,
            &decoded.payload,
        )
        .unwrap()
        .unwrap();
        Upstream::Source {
            connection: Arc::from("desk"),
            agent: Arc::from("desk"),
            seq: None,
            event,
        }
    }

    /// an actor built from what a start rebuilt, as `spawn` builds it.
    fn actor_from(model: Model, resumed: persist::Resumed) -> Actor {
        let mut a = actor();
        a.model = model;
        a.journal = Journal::resumed(resumed.epoch, resumed.head);
        a.encoder = resumed.encoder;
        a.keys = resumed.keys;
        a.cursors = resumed.cursors;
        a.started(resumed.how, &resumed.broken.threads);
        a
    }

    fn started_db() -> (Actor, rusqlite::Connection) {
        let mut actor = actor();
        actor.journal = Journal::new("0123456789ab".into());
        actor.upstream(host(1));
        actor.upstream(read_at(5));
        (actor, database())
    }

    #[test]
    fn a_clean_stop_with_thread_costs_keeps_its_epoch() {
        let (mut actor, mut db) = started_db();
        // costs as a daemon sums them: 17 significant digits
        let costs = [
            "0.9482029999999999",
            "1.0406366999999999",
            "0.014858301547846179",
            "0.30000000000000004",
            "0.1",
            "123456.78901234567",
        ];
        for (n, cost) in costs.iter().enumerate() {
            actor.upstream(sequenced(
                session_cost(&format!("ses_{n}"), cost),
                6 + n as u64,
            ));
        }
        let pending = actor.encoder.flush();
        actor.journal_all(pending);
        let clean = actor.take_batch(true);
        written(&mut db, &mut actor, &clean, true);
        let resumed = persist::start(persist::load(&db).unwrap());
        assert_eq!(resumed.how, persist::How::Clean);
        assert_eq!(
            resumed.epoch, "0123456789ab",
            "a float in a body never moves the epoch"
        );
    }

    #[test]
    fn a_person_s_send_stop_or_answer_marks_the_order_row() {
        let (mut actor, mut db) = started_db();
        actor.upstream(sequenced(session_in("ses_1", "/w"), 6));
        let first = actor.take_batch(false);
        written(&mut db, &mut actor, &first, true);
        assert!(!actor.persist.is_dirty());
        let device = model::Device {
            id: "phone".into(),
            class: "phone".into(),
        };
        actor.command(Command::Arm {
            key: "desk:ses_1".into(),
            client_id: "cid-1".into(),
            device: device.clone(),
        });
        actor.command(Command::OwnAction {
            key: "desk:ses_1".into(),
        });
        actor.command(Command::Answering {
            host: "desk".into(),
            ask: "que_1".into(),
            device,
        });
        let clean = actor.take_batch(true);
        written(&mut db, &mut actor, &clean, true);
        let stored = persist::load(&db).unwrap().unwrap();
        let order = stored
            .rows
            .iter()
            .find(|r| r.kind == "order")
            .and_then(|r| r.model.clone());
        assert_eq!(
            order,
            actor.model.order_state(),
            "the clean stop kept what the model holds"
        );
        assert!(order.unwrap().contains("cid-1"));
    }

    #[test]
    fn after_a_crash_what_moved_past_the_kept_body_goes_out_before_any_stream_is_served() {
        let (mut actor, mut db) = started_db();
        actor.upstream(sequenced(session_in("ses_1", "/w"), 6));
        let pending = actor.encoder.flush();
        actor.journal_all(pending);
        let first = actor.take_batch(false);
        written(&mut db, &mut actor, &first, true);
        // a person marks it read: its own table keeps it at once, the stream batch is a tick away
        let device = model::Device {
            id: "phone".into(),
            class: "phone".into(),
        };
        let (reply, _answer) = oneshot::channel();
        actor.command(Command::MarkRead {
            key: "desk:ses_1".into(),
            device,
            message: "msg_1".into(),
            at: 50.0,
            reply,
        });
        let read_of = |actor: &Actor, journaled: bool| {
            let fleet = if journaled {
                actor.journaled()
            } else {
                actor.model.snapshot()
            };
            fleet
                .threads
                .iter()
                .find(|t| t.key == "desk:ses_1")
                .map(|t| serde_json::to_string(&t.read).unwrap())
        };
        let live = read_of(&actor, true);
        assert_ne!(live.as_deref(), Some("null"));
        // the crash: no further batch; the read table holds the mark
        let resumed = persist::start(persist::load(&db).unwrap());
        assert_eq!(resumed.how, persist::How::Crash);
        let mut resumed = resumed;
        let reads = Reads::restore(vec![(
            "desk:ses_1".into(),
            Mark {
                device: "phone".into(),
                at: 50.0,
                message: "msg_1".into(),
                marked_at: 0,
            },
        )]);
        let mut model = Model::restored(
            Needs::default(),
            reads,
            Clears::default(),
            Vec::new(),
            Colours::default(),
        );
        assert_eq!(model.resume(std::mem::take(&mut resumed.model)), 0);
        let back = actor_from(model, resumed);
        assert_eq!(
            read_of(&back, true),
            read_of(&back, false),
            "a reset or /api/fleet serves the mark"
        );
        assert!(
            read_of(&back, true).is_some_and(|r| r.contains("msg_1")),
            "the mark the person made before the crash"
        );
    }

    #[test]
    fn a_model_row_that_does_not_decode_is_read_again_never_lost() {
        let (mut actor, mut db) = started_db();
        actor.upstream(sequenced(session_in("ses_1", "/w"), 6));
        let pending = actor.encoder.flush();
        actor.journal_all(pending);
        let clean = actor.take_batch(true);
        written(&mut db, &mut actor, &clean, true);
        // a later build whose thread state gained a field: an older row still decodes
        db.execute(
            "UPDATE stream_keys SET model = json_remove(model, '$.said') WHERE kind = 'thread'",
            [],
        )
        .unwrap();
        let mut resumed = persist::start(persist::load(&db).unwrap());
        assert!(resumed.broken.is_empty());
        assert_eq!(Model::new().resume(std::mem::take(&mut resumed.model)), 0);
        // a row that cannot decode at all: its host is read again, and its thread leaves until then
        db.execute(
            "UPDATE stream_keys SET model = json_set(model, '$.sent', 'not a number') WHERE kind = 'thread'",
            [],
        )
        .unwrap();
        let mut resumed = persist::start(persist::load(&db).unwrap());
        assert_eq!(resumed.broken.threads, ["desk:ses_1"]);
        assert!(
            !resumed.cursors.contains_key("desk"),
            "the host is read again, not resumed"
        );
        let mut model = Model::new();
        assert_eq!(model.resume(std::mem::take(&mut resumed.model)), 1);
        let back = actor_from(model, resumed);
        assert!(back.journaled().threads.is_empty(), "devices hear it left");
        assert!(back.keys.thread("desk:ses_1").is_none());
    }

    #[test]
    fn a_newest_read_left_out_by_a_restart_is_asked_again() {
        let (mut first, mut db) = started_db();
        let (tails, mut asked) = mpsc::channel(8);
        first.tails = tails;
        let busy = |seq: u64| {
            let mut info: crate::source::ThreadFacts = crate::source::ThreadFacts {
                id: "ses_1".into(),
                title: "t".into(),
                rev: Some(3),
                ..Default::default()
            };
            info.updated = 2.0;
            Upstream::Source {
                connection: Arc::from("desk"),
                agent: Arc::from("desk"),
                seq: None,
                event: SourceEvent::Snapshot(Box::new(crate::source::Snapshot {
                    epoch: Some("ep".into()),
                    floors: crate::source::Floors {
                        threads: seq,
                        activities: seq,
                        permissions: seq,
                        questions: seq,
                    },
                    threads: vec![info],
                    activities: vec![crate::source::ThreadActivity {
                        thread: "ses_1".into(),
                        activity: crate::wire::Activity::Busy { since: Some(1.0) },
                        queued: 0,
                    }],
                    asks: Vec::new(),
                })),
            }
        };
        first.upstream(busy(6));
        first.upstream(busy(9));
        let newest = |asked: &mut mpsc::Receiver<TailRequest>| {
            let mut keys = Vec::new();
            while let Ok(request) = asked.try_recv() {
                if request.newest {
                    keys.push(request.key);
                }
            }
            keys
        };
        assert_eq!(newest(&mut asked), ["desk:ses_1"]);
        let batch = first.take_batch(true);
        written(&mut db, &mut first, &batch, true);
        let mut resumed = persist::start(persist::load(&db).unwrap());
        let mut model = Model::new();
        assert_eq!(model.resume(std::mem::take(&mut resumed.model)), 0);
        let mut back = actor();
        let (tails, mut asked) = mpsc::channel(8);
        back.tails = tails;
        back.model = model;
        back.journal = Journal::resumed(resumed.epoch.clone(), resumed.head);
        back.encoder = std::mem::take(&mut resumed.encoder);
        back.keys = std::mem::take(&mut resumed.keys);
        back.started(resumed.how, &resumed.broken.threads);
        assert_eq!(newest(&mut asked), ["desk:ses_1"], "asked again at start");
    }
}
