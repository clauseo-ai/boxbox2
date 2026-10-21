//! protocol 3's full resume (`docs/protocol.md`, section 10): what the
//! actor writes to `boxbox.db` so a restart costs devices nothing.
//!
//! the actor marks a key dirty as it journals it, and as a source event or
//! command moves the model's own state for it. every `TICK`, when something
//! is dirty and no batch waits for its acknowledgement, it takes one batch in
//! one step of its loop: the dirty keys' rows (the body a catch-up sends and
//! the model's state), the new tombstones, the head, the reserved mark and
//! every upstream cursor. the batch goes to the writer on its own channel
//! (capacity 1, awaited), the writer commits it as one transaction and
//! answers. **dirty marks stay until the answer is `ok`**: then the marks of
//! keys that did not change again since the batch was taken are cleared; on
//! an error everything stays dirty and the next tick tries again. so a cursor
//! is never written without every state it reflects.
//!
//! the byte cap: when a batch has waited `ACK_WAIT` for its answer, or the
//! dirty set would pass `BATCH_BYTES`, or the head nears the acknowledged
//! reserved mark, the actor stops taking source events until the answer
//! comes; the bounded upstream channel fills and the watchers wait, which is
//! backpressure on the daemons' sockets. devices keep getting what was
//! already journaled.
//!
//! at start (`load`, then `start`) the rows are read back. when the stored
//! encoder is this build's, every body is decoded and encoded again and must
//! come back byte for byte: a mismatch is a bug, logged, and mints a new
//! epoch. when it differs, every key goes out whole once and no epoch moves.
//! a clean stop keeps the head; a crash moves it to the reserved mark, sends
//! every key whole once and moves every thread's versions to the mark.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use super::encode::Encoder;
use super::keys::{Grave, Kept, StreamKeys};
use super::model::{Model, state};
use crate::journal::Cursor;
use crate::store::Store;
use crate::wire::{Agent, Ask, Change, ENCODER, Thread};

/// how often a batch may be taken.
pub const TICK: Duration = Duration::from_secs(1);
/// the dirty set's rows, at most, before source intake stops.
pub const BATCH_BYTES: usize = 16 * 1024 * 1024;
/// a batch waiting this long for its answer stops source intake.
pub const ACK_WAIT: Duration = Duration::from_secs(10);
/// the reserved mark is written this far past the head...
pub const RESERVE: u64 = 1_000_000;
/// ...whenever the head passes this far below it.
pub const RESERVE_AGAIN: u64 = 500_000;
/// intake stops this far below the acknowledged mark, so the few entries a
/// command or a clock journals while it is stopped never pass it.
pub const RESERVE_MARGIN: u64 = 100_000;
/// a clean stop's last batch is answered inside this, or the next start
/// takes the crash path.
pub const SHUTDOWN_BUDGET: Duration = Duration::from_secs(5);
/// a failing writer is logged at most this often.
const ERROR_EVERY: Duration = Duration::from_secs(60);
/// a row never written yet counts this much toward the dirty set.
const ROW_GUESS: usize = 4096;

/// one row of `stream_keys`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    Agent(String),
    Thread(String),
    /// `(agent, id)`.
    Ask(String, String),
    Order,
}

impl Key {
    fn kind(&self) -> &'static str {
        match self {
            Self::Agent(_) => "agent",
            Self::Thread(_) => "thread",
            Self::Ask(..) => "ask",
            Self::Order => "order",
        }
    }

    fn name(&self) -> String {
        match self {
            Self::Agent(key) | Self::Thread(key) => key.clone(),
            Self::Ask(agent, id) => format!("{agent}\n{id}"),
            Self::Order => String::new(),
        }
    }
}

/// the row a journaled entry moves.
#[must_use]
pub fn key_of(change: &Change) -> Option<Key> {
    Some(match change {
        Change::Agent { agent } => Key::Agent(agent.key.clone()),
        Change::AgentRemoved { agent } => Key::Agent(agent.clone()),
        Change::Thread { thread } => Key::Thread(thread.key.clone()),
        Change::ThreadPatch(patch) => Key::Thread(patch.key.clone()),
        Change::ThreadRemoved { key } | Change::ThreadReset { key } => Key::Thread(key.clone()),
        Change::Ask { ask } => Key::Ask(ask.agent.clone(), ask.id.clone()),
        Change::AskSettled(settled) => Key::Ask(settled.agent.clone(), settled.id.clone()),
        Change::Order { .. } | Change::OrderPatch { .. } => Key::Order,
        other => Key::Thread(other.transcript_key()?.to_owned()),
    })
}

/// one `stream_keys` row as written and read back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub kind: String,
    pub key: String,
    /// the key's newest entry; 0 when the journal never told it.
    pub seq: u64,
    pub whole: bool,
    pub v: u64,
    pub rv: u64,
    pub reset_seq: u64,
    pub srev: Option<u64>,
    pub raised: Option<u64>,
    pub turn: Option<String>,
    pub body: String,
    /// none when the model does not hold the key.
    pub model: Option<String>,
}

impl Row {
    fn bytes(&self) -> usize {
        self.body.len()
            + self.model.as_ref().map_or(0, String::len)
            + self.turn.as_ref().map_or(0, String::len)
            + self.key.len()
            + 64
    }
}

#[derive(Debug)]
pub enum Write {
    Put(Row),
    Drop { kind: &'static str, key: String },
}

/// one batch for the writer: one transaction.
#[derive(Debug)]
pub struct Batch {
    pub id: u64,
    pub epoch: String,
    pub head: u64,
    pub reserved: u64,
    pub clean: bool,
    pub gone_floor: u64,
    pub writes: Vec<Write>,
    pub graves: Vec<Grave>,
    pub cursors: Vec<(String, Cursor)>,
    /// the encoded rows' bytes.
    pub bytes: usize,
}

/// the writer's answer to one batch.
#[derive(Debug)]
pub struct Ack {
    pub id: u64,
    pub result: Result<(), String>,
}

#[derive(Debug)]
struct InFlight {
    id: u64,
    /// each key with the mark it had when the batch was taken.
    taken: Vec<(Key, u64)>,
    sizes: Vec<(Key, usize)>,
    at: Instant,
    graves: u64,
    reserved: u64,
}

/// the actor's side: dirty marks, the one batch in flight, the
/// acknowledged reserved mark.
#[derive(Debug)]
pub struct Persist {
    dirty: HashMap<Key, u64>,
    mark: u64,
    /// each key's row as last written, for the dirty set's bytes.
    sizes: HashMap<Key, usize>,
    dirty_bytes: usize,
    in_flight: Option<InFlight>,
    next_id: u64,
    /// the reserved mark the store has acknowledged.
    reserved: u64,
    /// the newest tombstone the store has acknowledged.
    graves: u64,
    last_error: Option<Instant>,
    /// the writer; none for an actor whose batches a test takes by hand.
    pub batches: Option<mpsc::Sender<Batch>>,
}

impl Persist {
    #[must_use]
    pub fn new(reserved: u64, graves: u64, batches: Option<mpsc::Sender<Batch>>) -> Self {
        Self {
            dirty: HashMap::new(),
            mark: 0,
            sizes: HashMap::new(),
            dirty_bytes: 0,
            in_flight: None,
            next_id: 1,
            reserved,
            graves,
            last_error: None,
            batches,
        }
    }

    /// for the tests that need no store: a reserved mark that is never near.
    #[cfg(test)]
    #[must_use]
    pub fn detached() -> Self {
        Self::new(u64::MAX / 4, 0, None)
    }

    /// the key changed: its row goes in the next batch.
    pub fn mark(&mut self, key: Key) {
        self.mark += 1;
        let size = self.sizes.get(&key).copied().unwrap_or(ROW_GUESS);
        if self.dirty.insert(key, self.mark).is_none() {
            self.dirty_bytes += size;
        }
    }

    #[must_use]
    pub fn is_dirty(&self) -> bool {
        !self.dirty.is_empty()
    }

    #[must_use]
    pub fn in_flight(&self) -> bool {
        self.in_flight.is_some()
    }

    #[must_use]
    pub fn dirty_bytes(&self) -> usize {
        self.dirty_bytes
    }

    /// whether the actor may take a source event now.
    #[must_use]
    pub fn intake_open(&self, head: u64, now: Instant) -> bool {
        let waited = self
            .in_flight
            .as_ref()
            .is_some_and(|f| now.duration_since(f.at) >= ACK_WAIT);
        let full = self.dirty_bytes >= BATCH_BYTES;
        let near = head.saturating_add(RESERVE_MARGIN) >= self.reserved;
        !(waited || full || near)
    }

    /// the reserved mark the next batch writes.
    #[must_use]
    pub fn next_reserved(&self, head: u64) -> u64 {
        if head.saturating_add(RESERVE_AGAIN) >= self.reserved {
            head + RESERVE
        } else {
            self.reserved
        }
    }

    /// whether a batch is due: none waits for its answer, and a key is
    /// dirty or the reserved mark must move.
    #[must_use]
    pub fn due(&self, head: u64) -> bool {
        self.in_flight.is_none() && (self.is_dirty() || self.next_reserved(head) != self.reserved)
    }

    /// the dirty keys, for the batch being taken.
    #[must_use]
    pub fn dirty_keys(&self) -> Vec<Key> {
        self.dirty.keys().cloned().collect()
    }

    /// the newest tombstone acknowledged: the batch takes the newer ones.
    #[must_use]
    pub fn graves_written(&self) -> u64 {
        self.graves
    }

    /// a batch was taken from the dirty keys as they stand; it is in flight.
    pub fn taken(&mut self, batch: &Batch, sizes: Vec<(Key, usize)>, now: Instant) {
        let taken = self.dirty.iter().map(|(k, m)| (k.clone(), *m)).collect();
        self.in_flight = Some(InFlight {
            id: batch.id,
            taken,
            sizes,
            at: now,
            graves: batch
                .graves
                .iter()
                .map(|g| g.seq)
                .max()
                .unwrap_or(self.graves),
            reserved: batch.reserved,
        });
    }

    /// the next batch's id.
    pub fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// the writer answered: on `ok` the marks of keys that did not change
    /// since the batch was taken are cleared. answers whether it was `ok`.
    pub fn acknowledged(&mut self, ack: &Ack, now: Instant) -> bool {
        let Some(flight) = self.in_flight.take_if(|f| f.id == ack.id) else {
            warn!(
                batch = ack.id,
                "an answer for a batch that is not in flight; ignored"
            );
            return false;
        };
        match &ack.result {
            Ok(()) => {
                for (key, size) in flight.sizes {
                    self.sizes.insert(key, size);
                }
                for (key, mark) in flight.taken {
                    if self.dirty.get(&key) == Some(&mark) {
                        self.dirty.remove(&key);
                    }
                }
                self.dirty_bytes = self
                    .dirty
                    .keys()
                    .map(|k| self.sizes.get(k).copied().unwrap_or(ROW_GUESS))
                    .sum();
                self.reserved = flight.reserved;
                self.graves = flight.graves;
                self.last_error = None;
                true
            }
            Err(e) => {
                if self
                    .last_error
                    .is_none_or(|at| now.duration_since(at) >= ERROR_EVERY)
                {
                    error!(error = %e, dirty = self.dirty.len(), "the stream state could not be written; it stays dirty and the next tick tries again");
                    self.last_error = Some(now);
                }
                false
            }
        }
    }
}

fn json(value: &impl serde::Serialize) -> Option<String> {
    serde_json::to_string(value).ok()
}

/// one key's row as the actor's state holds it now, or its removal.
#[must_use]
#[allow(clippy::too_many_lines, reason = "one arm per kind of row")]
pub fn row(key: &Key, model: &Model, keys: &StreamKeys, encoder: &Encoder) -> Write {
    let drop = || Write::Drop {
        kind: key.kind(),
        key: key.name(),
    };
    let row = match key {
        Key::Thread(name) => {
            let state = model.thread_state(name);
            let (place, turn) = keys.thread_row(name).unzip();
            let (body, whole) = match encoder.base(name) {
                Some(base) => (json(base), encoder.whole(name).unwrap_or(true)),
                // held but never journaled: its first frame goes whole
                None if state.is_some() => (model.thread(name).as_ref().and_then(json), true),
                None => (None, true),
            };
            let Some(body) = body else {
                return drop();
            };
            Row {
                kind: "thread".into(),
                key: name.clone(),
                seq: place.map_or(0, |t| t.seq),
                whole,
                v: place.map_or(0, |t| t.v),
                rv: place.map_or(0, |t| t.rv),
                reset_seq: place.map_or(0, |t| t.reset_seq),
                srev: model.srev(name),
                raised: None,
                turn: turn.flatten(),
                body,
                model: state,
            }
        }
        Key::Agent(name) => {
            let kept = keys.agent(name);
            let state = model.agent_state(name);
            let body = match kept {
                Some(kept) => json(&kept.body),
                None if state.is_some() => model.snapshot_agent(name).as_ref().and_then(json),
                None => None,
            };
            let Some(body) = body else {
                return drop();
            };
            Row {
                kind: "agent".into(),
                key: name.clone(),
                seq: kept.map_or(0, |k| k.seq),
                whole: false,
                v: 0,
                rv: 0,
                reset_seq: 0,
                srev: None,
                raised: None,
                turn: None,
                body,
                model: state,
            }
        }
        Key::Ask(agent, id) => {
            let kept = keys.ask(agent, id);
            let state = model.ask_state(agent, id);
            let body = match kept {
                Some(kept) => json(&kept.body),
                None if state.is_some() => model.neutral_ask(agent, id).as_ref().and_then(json),
                None => None,
            };
            let Some(body) = body else {
                return drop();
            };
            Row {
                kind: "ask".into(),
                key: key.name(),
                seq: kept.map_or(0, |k| k.seq),
                whole: false,
                v: 0,
                rv: 0,
                reset_seq: 0,
                srev: None,
                raised: kept.map(|k| k.raised),
                turn: None,
                body,
                model: state,
            }
        }
        Key::Order => {
            let Some(body) = json(&encoder.order_base()) else {
                return drop();
            };
            Row {
                kind: "order".into(),
                key: String::new(),
                seq: keys.order_seq(),
                whole: encoder.order_whole(),
                v: 0,
                rv: 0,
                reset_seq: 0,
                srev: None,
                raised: None,
                turn: None,
                body,
                model: model.order_state(),
            }
        }
    };
    Write::Put(row)
}

/// the batch's rows with their bytes, each key's for the dirty set.
#[must_use]
pub fn sized(writes: &[Write], dirty: &[Key]) -> (usize, Vec<(Key, usize)>) {
    let mut total = 0;
    let mut sizes = Vec::with_capacity(dirty.len());
    for (write, key) in writes.iter().zip(dirty) {
        let bytes = match write {
            Write::Put(row) => row.bytes(),
            Write::Drop { .. } => 0,
        };
        total += bytes;
        sizes.push((key.clone(), bytes));
    }
    (total, sizes)
}

/// the writer: one batch at a time, each one transaction, each answered.
pub async fn writer(store: Store, mut batches: mpsc::Receiver<Batch>, acks: mpsc::Sender<Ack>) {
    while let Some(batch) = batches.recv().await {
        let id = batch.id;
        let (rows, bytes, clean) = (batch.writes.len(), batch.bytes, batch.clean);
        let started = Instant::now();
        let result = store
            .call(move |connection| write(connection, &batch))
            .await
            .map_err(|e| e.to_string());
        if result.is_ok() && clean {
            info!(
                rows,
                bytes,
                ms = started.elapsed().as_millis(),
                "the stream state is written clean"
            );
        }
        // the actor has stopped: nothing waits for the answer
        if acks.send(Ack { id, result }).await.is_err() {
            break;
        }
    }
}

/// commits one batch.
///
/// # Errors
/// sqlite failed; nothing of the batch is kept.
pub fn write(connection: &mut Connection, batch: &Batch) -> rusqlite::Result<()> {
    let tx = connection.transaction()?;
    meta(
        &tx,
        &batch.epoch,
        batch.head,
        batch.reserved,
        batch.clean,
        ENCODER,
        batch.gone_floor,
    )?;
    {
        let mut grave = tx.prepare_cached(
            "INSERT INTO stream_gone (kind, key, seq, at, raised, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (kind, key) DO UPDATE SET seq = excluded.seq, at = excluded.at,
                 raised = excluded.raised, body = excluded.body",
        )?;
        for g in &batch.graves {
            grave.execute(rusqlite::params![
                g.kind,
                g.key,
                as_i64(g.seq),
                g.at,
                as_i64(g.raised),
                g.body
            ])?;
        }
        tx.execute(
            "DELETE FROM stream_gone WHERE seq <= ?1",
            [as_i64(batch.gone_floor)],
        )?;
        let mut put = tx.prepare_cached(
            "INSERT INTO stream_keys (kind, key, seq, whole, v, rv, reset_seq, srev, raised, turn, body, model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT (kind, key) DO UPDATE SET seq = excluded.seq, whole = excluded.whole,
                 v = excluded.v, rv = excluded.rv, reset_seq = excluded.reset_seq,
                 srev = excluded.srev, raised = excluded.raised, turn = excluded.turn,
                 body = excluded.body, model = excluded.model",
        )?;
        let mut revived =
            tx.prepare_cached("DELETE FROM stream_gone WHERE kind = ?1 AND key = ?2")?;
        let mut remove =
            tx.prepare_cached("DELETE FROM stream_keys WHERE kind = ?1 AND key = ?2")?;
        for w in &batch.writes {
            match w {
                Write::Put(r) => {
                    put.execute(rusqlite::params![
                        r.kind,
                        r.key,
                        as_i64(r.seq),
                        i64::from(r.whole),
                        as_i64(r.v),
                        as_i64(r.rv),
                        as_i64(r.reset_seq),
                        r.srev.map(as_i64),
                        r.raised.map(as_i64),
                        r.turn,
                        r.body,
                        r.model
                    ])?;
                    if r.seq > 0 {
                        revived.execute((&r.kind, &r.key))?;
                    }
                }
                Write::Drop { kind, key } => {
                    remove.execute((kind, key))?;
                }
            }
        }
        tx.execute("DELETE FROM upstream_cursors", [])?;
        let mut cursor = tx.prepare_cached(
            "INSERT INTO upstream_cursors (connection, epoch, seq) VALUES (?1, ?2, ?3)",
        )?;
        for (connection, at) in &batch.cursors {
            cursor.execute((connection, &at.epoch, as_i64(at.seq)))?;
        }
    }
    tx.commit()
}

/// sqlite integers are i64; seqs stay below 2^53.
fn as_i64(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn as_u64(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

/// writes the stream's one meta row.
///
/// # Errors
/// sqlite failed.
pub fn meta(
    connection: &Connection,
    epoch: &str,
    head: u64,
    reserved: u64,
    clean: bool,
    encoder: u32,
    gone_floor: u64,
) -> rusqlite::Result<()> {
    connection
        .prepare_cached(
            "INSERT INTO stream_meta (id, epoch, head, reserved, clean, encoder, gone_floor)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET epoch = excluded.epoch, head = excluded.head,
                 reserved = excluded.reserved, clean = excluded.clean,
                 encoder = excluded.encoder, gone_floor = excluded.gone_floor",
        )?
        .execute(rusqlite::params![
            epoch,
            as_i64(head),
            as_i64(reserved),
            i64::from(clean),
            i64::from(encoder),
            as_i64(gone_floor)
        ])
        .map(drop)
}

/// what `boxbox.db` holds of the stream.
#[derive(Debug, Default)]
pub struct Stored {
    pub epoch: String,
    pub head: u64,
    pub reserved: u64,
    pub clean: bool,
    pub encoder: u32,
    pub gone_floor: u64,
    pub rows: Vec<Row>,
    /// `(kind, key, seq, at, raised, body)`, oldest first.
    pub graves: Vec<(String, String, u64, i64, u64, String)>,
    pub cursors: Vec<(String, Cursor)>,
}

/// reads the stream's tables; none when no state was ever written.
///
/// # Errors
/// sqlite failed.
pub fn load(connection: &Connection) -> rusqlite::Result<Option<Stored>> {
    let meta = connection
        .query_row(
            "SELECT epoch, head, reserved, clean, encoder, gone_floor FROM stream_meta WHERE id = 1",
            [],
            |r| {
                Ok(Stored {
                    epoch: r.get(0)?,
                    head: as_u64(r.get(1)?),
                    reserved: as_u64(r.get(2)?),
                    clean: r.get::<_, i64>(3)? == 1,
                    encoder: u32::try_from(r.get::<_, i64>(4)?).unwrap_or(0),
                    gone_floor: as_u64(r.get(5)?),
                    ..Stored::default()
                })
            },
        )
        .optional()?;
    let Some(mut stored) = meta else {
        return Ok(None);
    };
    let mut rows = connection.prepare(
        "SELECT kind, key, seq, whole, v, rv, reset_seq, srev, raised, turn, body, model FROM stream_keys",
    )?;
    stored.rows = rows
        .query_map([], |r| {
            Ok(Row {
                kind: r.get(0)?,
                key: r.get(1)?,
                seq: as_u64(r.get(2)?),
                whole: r.get::<_, i64>(3)? == 1,
                v: as_u64(r.get(4)?),
                rv: as_u64(r.get(5)?),
                reset_seq: as_u64(r.get(6)?),
                srev: r.get::<_, Option<i64>>(7)?.map(as_u64),
                raised: r.get::<_, Option<i64>>(8)?.map(as_u64),
                turn: r.get(9)?,
                body: r.get(10)?,
                model: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut graves = connection
        .prepare("SELECT kind, key, seq, at, raised, body FROM stream_gone ORDER BY seq")?;
    stored.graves = graves
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                as_u64(r.get(2)?),
                r.get(3)?,
                as_u64(r.get(4)?),
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut cursors = connection.prepare("SELECT connection, epoch, seq FROM upstream_cursors")?;
    stored.cursors = cursors
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                Cursor {
                    epoch: r.get(1)?,
                    seq: as_u64(r.get(2)?),
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(stored))
}

/// how the stream starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    /// no usable state: a new epoch, nothing held.
    Fresh,
    /// a clean stop: the stored head, nothing whole.
    Clean,
    /// a crash: the head at the reserved mark, every key whole once, every
    /// thread's versions at the mark.
    Crash,
}

/// the stream as a start rebuilds it, for the actor.
#[derive(Debug)]
pub struct Resumed {
    pub how: How,
    pub epoch: String,
    pub head: u64,
    /// the reserved mark written before the first stream is served.
    pub reserved: u64,
    pub keys: StreamKeys,
    pub encoder: Encoder,
    pub model: state::Rows,
    pub cursors: HashMap<String, Cursor>,
    /// every key is written again in the first batch (a crash, another
    /// encoder, a failed check).
    pub rewrite: bool,
    /// the newest tombstone kept.
    pub graves: u64,
    /// the model rows that do not decode (`state::Rows::broken`).
    pub broken: state::Broken,
}

impl Resumed {
    /// nothing kept: a new epoch.
    #[must_use]
    pub fn fresh() -> Self {
        Self {
            how: How::Fresh,
            epoch: new_epoch(),
            head: 0,
            reserved: RESERVE,
            keys: StreamKeys::new(),
            encoder: Encoder::new(),
            model: state::Rows::default(),
            cursors: HashMap::new(),
            rewrite: false,
            graves: 0,
            broken: state::Broken::default(),
        }
    }
}

/// 12 lowercase hex.
#[must_use]
pub fn new_epoch() -> String {
    format!("{:012x}", rand::random::<u64>() & 0xffff_ffff_ffff)
}

/// a body decoded and encoded again must be the same bytes when this
/// build's encoder wrote it.
fn decoded<T: serde::de::DeserializeOwned + serde::Serialize>(
    body: &str,
    check: bool,
    mismatched: &mut usize,
) -> Option<T> {
    let value: T = serde_json::from_str(body).ok()?;
    if check && serde_json::to_string(&value).ok().as_deref() != Some(body) {
        *mismatched += 1;
    }
    Some(value)
}

/// rebuilds the stream from what was stored (`docs/protocol.md`, section
/// 10, start and crash consistency).
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "one pass over the rows, kind by kind"
)]
pub fn start(stored: Option<Stored>) -> Resumed {
    let Some(stored) = stored else {
        return Resumed::fresh();
    };
    let check = stored.encoder == ENCODER;
    let mut mismatched = 0usize;
    let mut broken = 0usize;
    let mut keys = StreamKeys::new();
    let mut encoder = Encoder::new();
    let mut model = state::Rows::default();
    for row in stored.rows {
        match row.kind.as_str() {
            "thread" => {
                let Some(thread) = decoded::<Thread>(&row.body, check, &mut mismatched) else {
                    broken += 1;
                    continue;
                };
                if row.seq > 0 {
                    keys.restore_thread(
                        row.key.clone(),
                        row.seq,
                        [row.v, row.rv, row.reset_seq],
                        row.turn.as_deref(),
                    );
                }
                encoder.restore_thread(thread, row.whole);
                if let Some(state) = row.model {
                    model.threads.push((row.key, state, row.srev));
                }
            }
            "agent" => {
                let Some(agent) = decoded::<Agent>(&row.body, check, &mut mismatched) else {
                    broken += 1;
                    continue;
                };
                if row.seq > 0 {
                    keys.restore_agent(Kept {
                        seq: row.seq,
                        body: agent,
                        raised: row.seq,
                    });
                }
                if let Some(state) = row.model {
                    model.agents.push((row.key, state));
                }
            }
            "ask" => {
                let Some(ask) = decoded::<Ask>(&row.body, check, &mut mismatched) else {
                    broken += 1;
                    continue;
                };
                if row.seq > 0 {
                    keys.restore_ask(Kept {
                        seq: row.seq,
                        body: ask,
                        raised: row.raised.unwrap_or(row.seq),
                    });
                }
                if let Some(state) = row.model {
                    let agent = row
                        .key
                        .split_once('\n')
                        .map_or(row.key.as_str(), |(a, _)| a)
                        .to_owned();
                    model.asks.push((agent, state));
                }
            }
            "order" => {
                let Some(order) = decoded::<Option<Vec<String>>>(&row.body, check, &mut mismatched)
                else {
                    broken += 1;
                    continue;
                };
                keys.restore_order(row.seq);
                if let Some(order) = order {
                    encoder.restore_order(order, row.whole);
                }
                model.order = row.model;
            }
            _ => broken += 1,
        }
    }
    let mut graves = Vec::with_capacity(stored.graves.len());
    let mut newest = 0;
    for (_, _, seq, at, raised, body) in stored.graves {
        match decoded::<Change>(&body, check, &mut mismatched) {
            Some(change) => {
                newest = newest.max(seq);
                graves.push((seq, at, raised, change));
            }
            None => broken += 1,
        }
    }
    keys.restore_graves(graves, stored.gone_floor);
    let mut epoch = stored.epoch;
    let mut rewrite = false;
    if mismatched > 0 || broken > 0 {
        let moved = new_epoch();
        error!(
            mismatched,
            broken,
            from = epoch,
            to = moved,
            "the kept stream state does not encode back to what was written; a new epoch, so every device starts from a reset"
        );
        epoch = moved;
        rewrite = true;
    }
    if !check {
        info!(
            stored = stored.encoder,
            build = ENCODER,
            "the kept stream state is from another encoder; every key goes out whole once"
        );
        encoder.all_whole();
        rewrite = true;
    }
    let (how, head) = if stored.clean {
        (How::Clean, stored.head)
    } else {
        // no seq is ever issued twice: a device's cursor past the persisted head catches up from it
        encoder.all_whole();
        keys.versions_to(stored.reserved);
        rewrite = true;
        (How::Crash, stored.reserved)
    };
    let mut cursors: HashMap<String, Cursor> = stored.cursors.into_iter().collect();
    // a model row that will not decode loses its thread: its host is read again instead of resumed
    let broken = model.broken();
    if !broken.is_empty() {
        error!(hosts = ?broken.hosts, threads = broken.threads.len(), every_host = broken.every_host, "kept model rows do not decode; their hosts are read again");
        if broken.every_host {
            cursors.clear();
        }
        for host in &broken.hosts {
            cursors.remove(host);
        }
    }
    Resumed {
        how,
        epoch,
        head,
        reserved: head + RESERVE,
        keys,
        encoder,
        model,
        cursors,
        rewrite,
        graves: newest,
        broken,
    }
}

/// reads what was kept, rebuilds the stream from it, and writes `clean = 0`
/// with the new reserved mark before anything is served.
///
/// # Errors
/// the store failed.
pub async fn resume(store: &Store) -> Result<Resumed, crate::store::StoreError> {
    let started = Instant::now();
    let stored = store.call(|c| load(c)).await?;
    let (rows, stored_encoder) = stored
        .as_ref()
        .map_or((0, ENCODER), |s| (s.rows.len(), s.encoder));
    let resumed = tokio::task::spawn_blocking(move || start(stored))
        .await
        .map_err(|e| crate::store::StoreError::Thread(std::io::Error::other(e)))?;
    let (epoch, head, reserved, floor) = (
        resumed.epoch.clone(),
        resumed.head,
        resumed.reserved,
        resumed.keys.gone_floor(),
    );
    // the encoder stays the stored one until the first batch writes every row in this build's
    let encoder = if resumed.rewrite && resumed.how != How::Fresh {
        stored_encoder
    } else {
        ENCODER
    };
    store
        .call(move |c| meta(c, &epoch, head, reserved, false, encoder, floor))
        .await?;
    info!(
        how = ?resumed.how,
        epoch = resumed.epoch,
        head,
        reserved,
        rows,
        cursors = resumed.cursors.len(),
        ms = started.elapsed().as_millis(),
        "the stream resumes"
    );
    Ok(resumed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch_of(persist: &mut Persist, head: u64) -> Batch {
        let batch = Batch {
            id: persist.next_id(),
            epoch: "0123456789ab".into(),
            head,
            reserved: persist.next_reserved(head),
            clean: false,
            gone_floor: 0,
            writes: Vec::new(),
            graves: Vec::new(),
            cursors: Vec::new(),
            bytes: 0,
        };
        let sizes = persist.dirty_keys().into_iter().map(|k| (k, 100)).collect();
        persist.taken(&batch, sizes, Instant::now());
        batch
    }

    #[test]
    fn dirty_marks_stay_until_the_writer_says_ok_and_a_key_that_moved_since_stays_dirty() {
        let mut persist = Persist::new(RESERVE, 0, None);
        persist.mark(Key::Thread("a:1".into()));
        persist.mark(Key::Thread("a:2".into()));
        assert!(persist.due(10));
        let batch = batch_of(&mut persist, 10);
        assert!(!persist.due(10), "one batch in flight");
        // the writer failed: everything stays dirty, and the next tick tries again
        let failed = Ack {
            id: batch.id,
            result: Err("disk full".into()),
        };
        assert!(!persist.acknowledged(&failed, Instant::now()));
        assert_eq!(persist.dirty_keys().len(), 2);
        assert!(persist.due(10));
        let batch = batch_of(&mut persist, 10);
        // a key moves while the batch is out
        persist.mark(Key::Thread("a:2".into()));
        let ok = Ack {
            id: batch.id,
            result: Ok(()),
        };
        assert!(persist.acknowledged(&ok, Instant::now()));
        assert_eq!(persist.dirty_keys(), [Key::Thread("a:2".into())]);
        // an answer for a batch not in flight changes nothing
        assert!(!persist.acknowledged(&ok, Instant::now()));
        assert_eq!(persist.dirty_keys().len(), 1);
    }

    #[test]
    fn intake_stops_at_the_byte_cap_a_batch_unanswered_for_ten_seconds_or_the_reserved_mark() {
        let now = Instant::now();
        let mut persist = Persist::new(RESERVE, 0, None);
        assert!(persist.intake_open(0, now));
        // the dirty set reaches 16 MiB of rows
        for n in 0..(BATCH_BYTES / ROW_GUESS) {
            persist.mark(Key::Thread(format!("a:{n}")));
        }
        assert!(!persist.intake_open(0, now));
        let batch = batch_of(&mut persist, 0);
        assert!(!persist.intake_open(0, now), "still dirty until the answer");
        persist.acknowledged(
            &Ack {
                id: batch.id,
                result: Ok(()),
            },
            now,
        );
        assert!(persist.intake_open(0, now), "the answer reopens it");
        // a batch the writer has not answered in 10 s
        persist.mark(Key::Order);
        let batch = batch_of(&mut persist, 0);
        assert!(persist.intake_open(0, now + Duration::from_secs(9)));
        assert!(!persist.intake_open(0, now + ACK_WAIT + Duration::from_secs(1)));
        persist.acknowledged(
            &Ack {
                id: batch.id,
                result: Ok(()),
            },
            now + ACK_WAIT,
        );
        assert!(persist.intake_open(0, now + ACK_WAIT));
        // the head near the acknowledged mark: no journaling past it before the next mark is written
        assert!(!persist.intake_open(RESERVE - RESERVE_MARGIN, now));
        assert_eq!(
            persist.next_reserved(RESERVE - RESERVE_AGAIN),
            2 * RESERVE - RESERVE_AGAIN
        );
        assert!(
            persist.due(RESERVE - RESERVE_AGAIN),
            "a mark to move is a batch on its own"
        );
        let batch = batch_of(&mut persist, RESERVE - RESERVE_AGAIN);
        persist.acknowledged(
            &Ack {
                id: batch.id,
                result: Ok(()),
            },
            now,
        );
        assert!(persist.intake_open(RESERVE - RESERVE_MARGIN, now));
    }

    fn database() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        connection
    }

    fn thread_json(key: &str, title: &str) -> String {
        format!(
            r#"{{"key":"{key}","agent":"a","id":"{}","title":"{title}","created":1.0,"updated":2.0,"activity":{{"state":"idle"}},"queued":0,"browseOnly":false,"agents":0,"processes":0,"tail":[],"needs":[],"read":null}}"#,
            key.split_once(':').unwrap().1
        )
    }

    fn row_of(key: &str, body: String) -> Row {
        Row {
            kind: "thread".into(),
            key: key.into(),
            seq: 7,
            whole: false,
            v: 7,
            rv: 5,
            reset_seq: 0,
            srev: Some(3),
            raised: None,
            turn: None,
            body,
            model: None,
        }
    }

    fn stored_with(connection: &mut Connection, clean: bool, body: &str) -> Option<Stored> {
        // the body as this build encodes it
        let thread: Thread = serde_json::from_str(body).unwrap();
        let body = serde_json::to_string(&thread).unwrap();
        let batch = Batch {
            id: 1,
            epoch: "0123456789ab".into(),
            head: 40,
            reserved: 40 + RESERVE,
            clean,
            gone_floor: 0,
            writes: vec![Write::Put(row_of("a:1", body))],
            graves: Vec::new(),
            cursors: vec![(
                "desk".into(),
                Cursor {
                    epoch: "e".into(),
                    seq: 9,
                },
            )],
            bytes: 0,
        };
        write(connection, &batch).unwrap();
        load(connection).unwrap()
    }

    #[test]
    fn a_clean_stop_resumes_at_its_head_with_its_epoch_its_rows_and_its_cursors() {
        let mut connection = database();
        assert!(load(&connection).unwrap().is_none());
        assert_eq!(start(None).how, How::Fresh);
        let stored = stored_with(&mut connection, true, &thread_json("a:1", "t"));
        let resumed = start(stored);
        assert_eq!(resumed.how, How::Clean);
        assert_eq!((resumed.epoch.as_str(), resumed.head), ("0123456789ab", 40));
        assert_eq!(resumed.reserved, 40 + RESERVE);
        assert!(!resumed.rewrite);
        assert_eq!(resumed.encoder.whole("a:1"), Some(false));
        let t = resumed.keys.thread("a:1").unwrap();
        assert_eq!((t.seq, t.v, t.rv), (7, 7, 5));
        assert_eq!(resumed.cursors["desk"].seq, 9);
    }

    #[test]
    fn a_crash_resumes_at_the_reserved_mark_with_every_key_whole_and_every_thread_s_versions_there()
    {
        let mut connection = database();
        let stored = stored_with(&mut connection, false, &thread_json("a:1", "t"));
        let resumed = start(stored);
        assert_eq!(resumed.how, How::Crash);
        assert_eq!(resumed.epoch, "0123456789ab", "a crash keeps the epoch");
        assert_eq!(resumed.head, 40 + RESERVE);
        assert_eq!(resumed.reserved, 40 + 2 * RESERVE);
        assert!(resumed.rewrite);
        assert_eq!(resumed.encoder.whole("a:1"), Some(true));
        assert!(resumed.encoder.order_whole());
        let t = resumed.keys.thread("a:1").unwrap();
        assert_eq!((t.v, t.rv), (40 + RESERVE, 40 + RESERVE));
    }

    #[test]
    fn a_body_that_does_not_encode_back_mints_an_epoch_and_another_encoder_only_sends_whole() {
        let mut connection = database();
        stored_with(&mut connection, true, &thread_json("a:1", "t"));
        // a body this build would not write: its fields out of order
        connection
            .execute(
                "UPDATE stream_keys SET body = ?1",
                [r#"{"agent":"a","key":"a:1","id":"1","title":"t","created":1.0,"updated":2.0,"activity":{"state":"idle"},"queued":0,"browseOnly":false,"agents":0,"processes":0,"tail":[],"needs":[],"read":null}"#],
            )
            .unwrap();
        let resumed = start(load(&connection).unwrap());
        assert_ne!(resumed.epoch, "0123456789ab", "a mismatch moves the epoch");
        assert!(resumed.rewrite);
        // the same body from another encoder: nothing to compare, every key whole, no epoch moved
        connection
            .execute("UPDATE stream_meta SET encoder = encoder + 1", [])
            .unwrap();
        let resumed = start(load(&connection).unwrap());
        assert_eq!(resumed.epoch, "0123456789ab");
        assert_eq!(resumed.how, How::Clean);
        assert!(resumed.rewrite);
        assert_eq!(resumed.encoder.whole("a:1"), Some(true));
    }

    #[test]
    fn a_batch_is_one_transaction_and_tombstones_go_below_the_floor() {
        let mut connection = database();
        let grave = |key: &str, seq: u64| Grave {
            kind: "thread",
            key: key.into(),
            seq,
            at: 1,
            raised: 0,
            body: format!(r#"{{"type":"thread.removed","key":"{key}"}}"#),
        };
        let mut batch = Batch {
            id: 1,
            epoch: "0123456789ab".into(),
            head: 40,
            reserved: 40 + RESERVE,
            clean: false,
            gone_floor: 0,
            writes: Vec::new(),
            graves: vec![grave("a:1", 3), grave("a:2", 5)],
            cursors: Vec::new(),
            bytes: 0,
        };
        write(&mut connection, &batch).unwrap();
        assert_eq!(load(&connection).unwrap().unwrap().graves.len(), 2);
        // the floor rose past a:1; a:2 came back
        batch.gone_floor = 3;
        batch.graves.clear();
        let body = serde_json::to_string(
            &serde_json::from_str::<Thread>(&thread_json("a:2", "t")).unwrap(),
        )
        .unwrap();
        batch.writes = vec![Write::Put(Row {
            key: "a:2".into(),
            ..row_of("a:2", body)
        })];
        write(&mut connection, &batch).unwrap();
        let stored = load(&connection).unwrap().unwrap();
        assert!(stored.graves.is_empty(), "{:?}", stored.graves);
        assert_eq!(stored.rows.len(), 1);
        // a write that fails keeps nothing of its batch
        batch.writes = vec![Write::Put(Row {
            kind: "nonsense".into(),
            ..row_of("a:3", "{}".into())
        })];
        batch.head = 99;
        assert!(write(&mut connection, &batch).is_err());
        assert_eq!(load(&connection).unwrap().unwrap().head, 40);
    }
}
