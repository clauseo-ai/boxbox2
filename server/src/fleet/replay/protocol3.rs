//! protocol 3's goldens before the server speaks it: the simulated
//! encoder (`docs/protocol.md`, section 16, frames for the app before the
//! server runs).
//!
//! the recorded tape (`server/goldens/contract1/tape.jsonl.gz`) replays
//! through today's actor, step by step on its recorded clock; each step's
//! contract 1 entries are re-encoded as protocol 3 by `fleet::encode`
//! (thread and order patches, 100 ms delta batches, finished text once),
//! translating the daemon objects inside them with the cmx2 source's
//! neutral translation. what that gives is written to
//! `server/goldens/protocol3/` as the streams three views would get:
//!
//! - `journal.sse.gz`: every protocol 3 entry, as one stream from cursor 0.
//! - `home.sse.gz`: `hello`, the first `reset`, and the overview: what a
//!   device on home (or hidden) gets for the whole tape.
//! - `thread.sse.gz`: the same with the busiest thread open, so its
//!   transcript entries ride along.
//! - `switch.sse.gz`: home until the middle of the tape, then an interest
//!   confirm opening the busiest thread with `since` at a quarter of the
//!   tape (its entries in between in a `catchup` frame), then that view.
//! - `hello-reset.sse.gz`: a first connection at the end of the tape.
//!
//! this module goes when the actor journals protocol 3 itself; the goldens
//! are then rewritten from the actor. `BOXBOX_GOLDENS=write cargo test
//! protocol3` rewrites them.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::PathBuf;

use bytes::Bytes;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

use super::Replay;
use crate::fleet::encode::Encoder;
use crate::fleet::tape::Step;
use crate::journal::sse_frame;
use crate::source::cmx2::translate;
use crate::wire::{
    Agent, Ask, AskKind, AskSettled, Change, Control, Fleet, Interest, JournalEntry, Outcome,
    PROTOCOL, ResetReason, TailItem, Thread,
};

const EPOCH: &str = "EPOCH";
const BUILD: &str = "BUILD";
const STREAM: &str = "00000000000000000000000000000000";

fn contract1(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("goldens/contract1")
        .join(name);
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    text
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("goldens/protocol3")
}

#[derive(Deserialize)]
struct Live {
    epoch: String,
    build: String,
}

/// one protocol 3 entry and the clock it was journaled at.
struct Entry {
    seq: u64,
    at: i64,
    change: Change,
}

/// contract 1's journal as protocol 3: the encoder plus what a host read
/// needs to diff against (the threads and asks each host holds).
struct Simulated {
    encoder: Encoder,
    entries: Vec<Entry>,
    agents: BTreeMap<String, Agent>,
    threads: BTreeMap<String, Thread>,
    asks: BTreeMap<(String, String), Ask>,
    order: Vec<String>,
}

fn raw(value: &Value) -> Box<RawValue> {
    serde_json::value::to_raw_value(value).unwrap()
}

/// a contract 1 session entry as a neutral thread.
fn thread_of(session: &Value) -> Thread {
    let facts = translate::thread_from_json(raw(&session["info"])).unwrap();
    let activity = match &session["status"] {
        Value::Null => crate::wire::Activity::Idle,
        status => translate::activity(&serde_json::from_value(status.clone()).unwrap()),
    };
    let tail: Vec<TailItem> = serde_json::from_value(session["tail"].clone()).unwrap();
    Thread {
        key: session["key"].as_str().unwrap().to_owned(),
        agent: session["host"].as_str().unwrap().to_owned(),
        id: facts.id,
        title: facts.title,
        created: facts.created,
        updated: facts.updated,
        said: facts.said,
        generation: facts.generation,
        parent: facts.parent,
        place: facts.place,
        origin: facts.origin,
        activity,
        queued: facts.queued,
        sends: None,
        model: facts.model,
        effort: facts.effort,
        context: facts.context,
        cost: facts.cost,
        tokens: facts.tokens,
        vcs: facts.vcs,
        changes: facts.changes,
        browse_only: facts.browse_only,
        agents: u32::try_from(session["agents"].as_u64().unwrap_or(0)).unwrap_or(0),
        processes: u32::try_from(session["processes"].as_u64().unwrap_or(0)).unwrap_or(0),
        tail,
        needs: serde_json::from_value(session["needs"].clone()).unwrap(),
        read: serde_json::from_value(session["read"].clone()).unwrap(),
        cleared: session["cleared"].as_f64(),
    }
}

fn ask_of(ask: &Value) -> Ask {
    let kind = match ask["kind"].as_str() {
        Some("question") => AskKind::Question,
        _ => AskKind::Permission,
    };
    translate::ask(ask["host"].as_str().unwrap(), kind, &raw(&ask["request"])).unwrap()
}

impl Simulated {
    fn new() -> Self {
        Self {
            encoder: Encoder::new(),
            entries: Vec::new(),
            agents: BTreeMap::new(),
            threads: BTreeMap::new(),
            asks: BTreeMap::new(),
            order: Vec::new(),
        }
    }

    fn head(&self) -> u64 {
        self.entries.last().map_or(0, |e| e.seq)
    }

    fn journal(&mut self, at: i64, changes: Vec<Change>) {
        for change in changes {
            let seq = self.head() + 1;
            self.entries.push(Entry { seq, at, change });
        }
    }

    fn thread(&mut self, at: i64, thread: Thread) {
        self.threads.insert(thread.key.clone(), thread.clone());
        let out = self.encoder.thread(thread);
        self.journal(at, out);
    }

    fn removed(&mut self, at: i64, key: &str) {
        self.threads.remove(key);
        let out = self.encoder.thread_removed(key);
        self.journal(at, out);
    }

    fn settled(&mut self, at: i64, agent: &str, id: &str, outcome: Outcome) {
        if self
            .asks
            .remove(&(agent.to_owned(), id.to_owned()))
            .is_none()
        {
            return;
        }
        #[allow(clippy::cast_precision_loss)]
        let settled = AskSettled {
            agent: agent.to_owned(),
            id: id.to_owned(),
            outcome,
            option: None,
            reason: None,
            by: None,
            at: at as f64,
        };
        let out = self.encoder.other(Change::AskSettled(settled));
        self.journal(at, out);
    }

    /// one contract 1 entry, re-encoded.
    #[allow(clippy::too_many_lines, reason = "one arm per contract 1 entry")]
    fn entry(&mut self, at: i64, entry: &Value) {
        let text = |field: &str| entry[field].as_str().unwrap().to_owned();
        let upstream = entry["upstream"].as_u64();
        match entry["type"].as_str().unwrap() {
            "host" => {
                let status: crate::upstream::HostStatus =
                    serde_json::from_value(entry["host"].clone()).unwrap();
                let facts = translate::agent(&status.name);
                let connection = translate::connection(status);
                let agent = Agent {
                    key: facts.key,
                    label: facts.label,
                    kind: facts.kind,
                    source: facts.source,
                    mark: facts.mark,
                    palette: facts.palette,
                    status: connection.status,
                    connection: connection.connection,
                    capabilities: facts.capabilities,
                    runs: None,
                };
                if self.agents.get(&agent.key) != Some(&agent) {
                    self.agents.insert(agent.key.clone(), agent.clone());
                    let out = self.encoder.other(Change::Agent { agent });
                    self.journal(at, out);
                }
            }
            "host.removed" => {
                let host = text("host");
                let prefix = format!("{host}:");
                let keys: Vec<String> = self
                    .threads
                    .keys()
                    .filter(|k| k.starts_with(&prefix))
                    .cloned()
                    .collect();
                for key in keys {
                    self.removed(at, &key);
                }
                self.asks.retain(|(agent, _), _| *agent != host);
                self.agents.remove(&host);
                let out = self.encoder.other(Change::AgentRemoved { agent: host });
                self.journal(at, out);
            }
            "host.reset" => {
                // the quiet re-read: a diff against what the host held, and a
                // reset of every transcript it held (no revision to go by)
                let host = text("host");
                let prefix = format!("{host}:");
                let fresh: Vec<Thread> = entry["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(thread_of)
                    .collect();
                let held: Vec<String> = self
                    .threads
                    .keys()
                    .filter(|k| k.starts_with(&prefix))
                    .cloned()
                    .collect();
                for key in &held {
                    if !fresh.iter().any(|t| &t.key == key) {
                        self.removed(at, key);
                    }
                }
                for thread in fresh {
                    let key = thread.key.clone();
                    self.thread(at, thread);
                    if held.contains(&key) {
                        let out = self.encoder.thread_reset(&key);
                        self.journal(at, out);
                    }
                }
                let asks: Vec<Ask> = entry["asks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(ask_of)
                    .collect();
                let gone: Vec<String> = self
                    .asks
                    .keys()
                    .filter(|(agent, id)| *agent == host && !asks.iter().any(|a| &a.id == id))
                    .map(|(_, id)| id.clone())
                    .collect();
                for id in gone {
                    self.settled(at, &host, &id, Outcome::Unknown);
                }
                for ask in asks {
                    let id = (host.clone(), ask.id.clone());
                    if self.asks.get(&id) != Some(&ask) {
                        self.asks.insert(id, ask.clone());
                        let out = self.encoder.other(Change::Ask { ask });
                        self.journal(at, out);
                    }
                }
            }
            "session" => {
                let thread = thread_of(&entry["session"]);
                self.thread(at, thread);
            }
            "session.removed" => self.removed(at, &text("key")),
            "ask" => {
                let ask = ask_of(&entry["ask"]);
                self.asks
                    .insert((ask.agent.clone(), ask.id.clone()), ask.clone());
                let out = self.encoder.other(Change::Ask { ask });
                self.journal(at, out);
            }
            // contract 1 does not say how; the simulated tapes say answered
            "ask.settled" => self.settled(at, &text("host"), &text("id"), Outcome::Answered),
            "order" => {
                let keys: Vec<String> = serde_json::from_value(entry["keys"].clone()).unwrap();
                self.order.clone_from(&keys);
                let out = self.encoder.order(keys);
                self.journal(at, out);
            }
            "message" => {
                let message = translate::message(&raw(&entry["info"])).unwrap();
                let out = self.encoder.message(&text("key"), upstream, message);
                self.journal(at, out);
            }
            "part" => {
                let part = translate::part(&raw(&entry["part"]));
                let out = self.encoder.part(&text("key"), upstream, part);
                self.journal(at, out);
            }
            "delta" => {
                let out = self.encoder.delta(
                    at,
                    &text("key"),
                    &text("messageID"),
                    &text("partID"),
                    &text("field"),
                    &text("delta"),
                    entry["offset"].as_u64().unwrap(),
                );
                self.journal(at, out);
            }
            "message.removed" => {
                let out = self
                    .encoder
                    .message_removed(&text("key"), upstream, text("messageID"));
                self.journal(at, out);
            }
            other => panic!("contract 1 has no {other} entry"),
        }
    }

    /// the clock moved to `at`: deltas whose 100 ms passed go.
    fn tick(&mut self, at: i64) {
        while let Some(due) = self.encoder.due() {
            if due > at {
                break;
            }
            let out = self.encoder.flush_due(due);
            self.journal(due, out);
        }
    }

    fn fleet(&self) -> Fleet {
        Fleet {
            agents: self.agents.values().cloned().collect(),
            threads: self.threads.values().cloned().collect(),
            asks: self.asks.values().cloned().collect(),
            order: self.order.clone(),
        }
    }
}

/// the tape replayed, each step's new contract 1 entries re-encoded.
fn simulate() -> (Simulated, i64, Fleet) {
    let live: Live = serde_json::from_str(&contract1("live.json.gz")).unwrap();
    let steps: Vec<Step> = contract1("tape.jsonl.gz")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let mut replay = Replay::new(&live.epoch, &live.build);
    let mut sim = Simulated::new();
    let mut seen = 0u64;
    let mut end = 0;
    for step in steps {
        let at = step.at;
        end = at;
        sim.tick(at);
        replay.step(step).unwrap();
        let head = replay.head();
        if head > seen {
            for frame in replay.journal().iter().skip(usize::try_from(seen).unwrap()) {
                sim.entry(at, &data(frame));
            }
            seen = head;
        }
    }
    sim.tick(end + 1000);
    let fleet = sim.fleet();
    let _ = live.build;
    (sim, end, fleet)
}

/// the json object a frame carries.
fn data(frame: &Bytes) -> Value {
    let text = std::str::from_utf8(frame).unwrap();
    let json: String = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&json).unwrap()
}

fn frame_of(entry: &Entry) -> Bytes {
    let json = serde_json::to_vec(&JournalEntry {
        seq: entry.seq,
        change: entry.change.clone(),
    })
    .unwrap();
    sse_frame(Some(&format!("{EPOCH}:{}", entry.seq)), &json)
}

fn control(id: Option<u64>, control: &Control) -> Bytes {
    let json = serde_json::to_vec(control).unwrap();
    sse_frame(id.map(|s| format!("{EPOCH}:{s}")).as_deref(), &json)
}

fn hello(head: u64, interest: Interest) -> Bytes {
    control(
        None,
        &Control::Hello {
            protocol: PROTOCOL,
            epoch: EPOCH.into(),
            head,
            build: BUILD.into(),
            stream: STREAM.into(),
            interest,
        },
    )
}

fn empty_reset() -> Bytes {
    control(
        Some(0),
        &Control::Reset {
            seq: 0,
            epoch: EPOCH.into(),
            reason: ResetReason::None,
            fleet: Fleet {
                agents: Vec::new(),
                threads: Vec::new(),
                asks: Vec::new(),
                order: Vec::new(),
            },
        },
    )
}

/// whether a stream with `thread` open gets `entry`.
fn shows(entry: &Entry, thread: Option<&str>) -> bool {
    entry
        .change
        .transcript_key()
        .is_none_or(|key| Some(key) == thread)
}

/// the thread with the most transcript entries.
fn busiest(sim: &Simulated) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for entry in &sim.entries {
        if let Some(key) = entry.change.transcript_key() {
            *counts.entry(key).or_default() += 1;
        }
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    counts[0].0.to_owned()
}

/// raw bytes, and bytes through one deflate stream flushed after each frame.
fn sizes(frames: &[Bytes]) -> (usize, usize) {
    let raw = frames.iter().map(Bytes::len).sum();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
    for frame in frames {
        gz.write_all(frame).unwrap();
        gz.flush().unwrap();
    }
    (raw, gz.finish().unwrap().len())
}

fn golden(name: &str, frames: &[Bytes]) {
    let text: String = frames
        .iter()
        .map(|f| std::str::from_utf8(f).unwrap())
        .collect();
    let path = dir().join(name);
    if std::env::var("BOXBOX_GOLDENS").as_deref() == Ok("write") {
        std::fs::create_dir_all(dir()).unwrap();
        let mut out = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        out.write_all(text.as_bytes()).unwrap();
        std::fs::write(&path, out.finish().unwrap()).unwrap();
        return;
    }
    let mut expected = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}; write it with BOXBOX_GOLDENS=write",
            path.display()
        )
    }))
    .read_to_string(&mut expected)
    .unwrap();
    assert!(expected == text, "{name} differs from its golden");
}

#[test]
fn protocol3_goldens_from_the_simulated_encoder() {
    let (sim, end, fleet) = simulate();
    let thread = busiest(&sim);
    let head = sim.head();

    let journal: Vec<Bytes> = sim.entries.iter().map(frame_of).collect();

    let mut home = vec![hello(0, Interest::default()), empty_reset()];
    home.extend(sim.entries.iter().filter(|e| shows(e, None)).map(frame_of));

    let open = Interest {
        thread: Some(thread.clone()),
        under: Vec::new(),
        holds: Vec::new(),
    };
    let mut opened = vec![hello(0, open.clone()), empty_reset()];
    opened.extend(
        sim.entries
            .iter()
            .filter(|e| shows(e, Some(&thread)))
            .map(frame_of),
    );

    // home, then the busiest thread opened mid-tape with `since` a quarter in
    let (since, at) = (head / 4, head / 2);
    let mut switch = vec![hello(0, Interest::default()), empty_reset()];
    switch.extend(
        sim.entries
            .iter()
            .filter(|e| e.seq <= at && shows(e, None))
            .map(frame_of),
    );
    let caught: Vec<JournalEntry> = sim
        .entries
        .iter()
        .filter(|e| e.seq > since && e.seq <= at && e.change.transcript_key() == Some(&thread))
        .map(|e| JournalEntry {
            seq: e.seq,
            change: e.change.clone(),
        })
        .collect();
    if !caught.is_empty() {
        switch.push(control(None, &Control::Catchup { entries: caught }));
    }
    switch.push(control(
        Some(at),
        &Control::Interest {
            ask: 1,
            thread: Some(thread.clone()),
            under: Vec::new(),
            holds: Vec::new(),
            seq: at,
            stale: Vec::new(),
            reset: Vec::new(),
        },
    ));
    switch.extend(
        sim.entries
            .iter()
            .filter(|e| e.seq > at && shows(e, Some(&thread)))
            .map(frame_of),
    );

    let reset = vec![
        hello(head, Interest::default()),
        control(
            Some(head),
            &Control::Reset {
                seq: head,
                epoch: EPOCH.into(),
                reason: ResetReason::None,
                fleet,
            },
        ),
    ];

    // every frame decodes back to what was encoded
    for frame in &journal {
        let entry: JournalEntry = serde_json::from_value(data(frame)).unwrap();
        let _ = entry;
    }

    let minutes = |bytes: usize| {
        #[allow(clippy::cast_precision_loss)]
        let per = bytes as f64 * 60_000.0 / (end - sim.entries[0].at).max(1) as f64;
        per
    };
    for (name, frames) in [
        ("journal", &journal),
        ("home", &home),
        ("thread", &opened),
        ("switch", &switch),
    ] {
        let (raw, gz) = sizes(frames);
        println!(
            "{name}: {} frames, {raw} B raw ({:.0} B/min), {gz} B gzip ({:.0} B/min)",
            frames.len(),
            minutes(raw),
            minutes(gz)
        );
    }

    golden("journal.sse.gz", &journal);
    golden("home.sse.gz", &home);
    golden("thread.sse.gz", &opened);
    golden("switch.sse.gz", &switch);
    golden("hello-reset.sse.gz", &reset);
}
