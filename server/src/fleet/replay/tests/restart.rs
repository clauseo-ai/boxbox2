//! the restart proofs over the recorded tape (`docs/protocol.md`, sections
//! 10 and 16, restart kills): the actor stops at seeded steps (a) cleanly
//! and (b) without writing its last batch, starts again from its database
//! and goes on with the tape, beside a run that never stopped.
//!
//! a device connected across the restart resumes from its cursor. after a
//! clean stop it gets no reset, no catch-up and no stale thread (no read at
//! all); after a crash it gets no reset either, every key comes once whole,
//! and every thread's versions sit at the reserved mark, so each etag
//! misses once. in both, the device's overview and the restarted model end
//! equal to the run that never stopped.

use std::collections::BTreeMap;

use bytes::Bytes;
use rusqlite::Connection;

use super::{Client, data, end, live, tape};
use crate::fleet::persist::How;
use crate::fleet::replay::Replay;
use crate::fleet::tape::{Input, Step};
use crate::fleet::{Feed, From, Live};
use crate::journal::Cursor;
use crate::wire::{Fleet, Interest, JournalEntry, Thread};

/// a database with this build's schema, in memory.
fn database() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    crate::store::migrate_for_tests(&mut connection);
    connection
}

/// a device built only from what its stream sends: the overview by the
/// client's rules, its cursor by the cursor rule, and what it was told to
/// read.
#[derive(Default)]
struct Device {
    client: Client,
    cursor: Option<Cursor>,
    resets: usize,
    stale: Vec<String>,
    catchups: usize,
    whole: usize,
}

impl Device {
    fn take(&mut self, frames: &[Bytes]) {
        for frame in frames {
            let text = std::str::from_utf8(frame).unwrap();
            let id = text
                .lines()
                .find_map(|l| l.strip_prefix("id: "))
                .and_then(Cursor::parse);
            let value = data(frame);
            let kind = value["type"].as_str().unwrap_or_default().to_owned();
            match kind.as_str() {
                "hello" | "colours" | "colour" | "away" | "autoCleared" | "caught" | "interest" => {
                }
                "catchup" => self.catchups += 1,
                "thread.stale" => self
                    .stale
                    .push(value["key"].as_str().unwrap_or_default().to_owned()),
                "reset" => {
                    self.resets += 1;
                    let fleet: Fleet = serde_json::from_value(value["fleet"].clone()).unwrap();
                    self.client = Client::default();
                    for agent in fleet.agents {
                        self.client.agents.insert(agent.key.clone(), agent);
                    }
                    for thread in fleet.threads {
                        self.client.threads.insert(thread.key.clone(), thread);
                    }
                    for ask in fleet.asks {
                        self.client
                            .asks
                            .insert((ask.agent.clone(), ask.id.clone()), ask);
                    }
                    self.client.order = fleet.order;
                }
                _ => {
                    let entry: JournalEntry = serde_json::from_value(value).unwrap();
                    if self.cursor.as_ref().is_some_and(|c| entry.seq <= c.seq) {
                        continue;
                    }
                    if matches!(entry.change, crate::wire::Change::Thread { .. }) {
                        self.whole += 1;
                    }
                    self.client
                        .apply(entry.change)
                        .unwrap_or_else(|e| panic!("entry {}: {e}", entry.seq));
                }
            }
            if let Some(id) = id {
                self.cursor = Some(id);
            }
        }
    }

    fn drain(&mut self, live: &mut Live) {
        let mut frames = Vec::new();
        while let Ok(feed) = live.frames.try_recv() {
            match feed {
                Feed::Frame(frame) => {
                    // the stream takes what it sends out of its queue, as `http/stream.rs` does
                    live.queued
                        .fetch_sub(frame.len(), std::sync::atomic::Ordering::AcqRel);
                    frames.push(frame);
                }
                Feed::Block { frames: block, .. } => frames.extend(block),
            }
        }
        self.take(&frames);
    }
}

/// the model's overview, held tails as the device holds them flushed.
fn overview(
    replay: &Replay,
) -> (
    Vec<String>,
    BTreeMap<String, Thread>,
    Vec<String>,
    Vec<String>,
) {
    let fleet = replay.snapshot();
    let mut agents: Vec<String> = fleet
        .agents
        .iter()
        .map(|a| serde_json::to_string(a).unwrap())
        .collect();
    agents.sort();
    let mut asks: Vec<String> = fleet
        .asks
        .iter()
        .map(|a| serde_json::to_string(a).unwrap())
        .collect();
    asks.sort();
    let threads = fleet
        .threads
        .into_iter()
        .map(|t| (t.key.clone(), t))
        .collect();
    (agents, threads, asks, fleet.order)
}

fn client_overview(
    client: &Client,
) -> (
    Vec<String>,
    BTreeMap<String, Thread>,
    Vec<String>,
    Vec<String>,
) {
    let mut agents: Vec<String> = client
        .agents
        .values()
        .map(|a| serde_json::to_string(a).unwrap())
        .collect();
    agents.sort();
    let mut asks: Vec<String> = client
        .asks
        .values()
        .map(|a| serde_json::to_string(a).unwrap())
        .collect();
    asks.sort();
    (agents, client.threads.clone(), asks, client.order.clone())
}

/// the window of tape steps a restart at `stop` may take: the steps after
/// the last batch before it, none of them a host or tail read (the reads a
/// restarted server asks again itself, which the tape cannot answer).
fn restartable(steps: &[Step], from: usize, to: usize) -> bool {
    steps[from..=to]
        .iter()
        .all(|s| !matches!(s.input, Input::HostRead(_) | Input::TailRead { .. }))
}

const SEEDS: [u64; 4] = [3, 17, 41, 97];

fn seeded(seed: u64, below: usize) -> usize {
    let mut x = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ 0xdead_beef;
    x ^= x >> 31;
    usize::try_from(x % below as u64).unwrap_or(0)
}

/// the tape, uninterrupted, with every held tail flushed at its end.
fn uninterrupted(steps: Vec<Step>, at: i64) -> Replay {
    let live = live();
    let mut replay = Replay::new(&live.epoch, &live.build);
    for step in steps {
        replay.step(step).unwrap();
    }
    replay.flush_deltas(at + 1000);
    replay.flush_tails(at + 2000);
    replay
}

/// the busiest thread on the tape, which the device keeps open.
fn stage(replay: &Replay) -> Option<String> {
    replay
        .snapshot()
        .threads
        .iter()
        .find(|t| t.parent.is_none())
        .map(|t| t.key.clone())
}

type Overview = (
    Vec<String>,
    BTreeMap<String, Thread>,
    Vec<String>,
    Vec<String>,
);

/// where two overviews part, in a line; none when they are equal.
fn apart(a: &Overview, b: &Overview) -> Option<String> {
    if a.0 != b.0 {
        return Some(format!("agents: {:?} / {:?}", a.0, b.0));
    }
    let ka: Vec<&String> = a.1.keys().collect();
    let kb: Vec<&String> = b.1.keys().collect();
    if ka != kb {
        let only_a: Vec<_> = ka.iter().filter(|k| !b.1.contains_key(**k)).collect();
        let only_b: Vec<_> = kb.iter().filter(|k| !a.1.contains_key(**k)).collect();
        return Some(format!(
            "threads only left {only_a:?}, only right {only_b:?}"
        ));
    }
    for (key, ta) in &a.1 {
        let tb = &b.1[key];
        if ta != tb {
            let ja = serde_json::to_value(ta).unwrap();
            let jb = serde_json::to_value(tb).unwrap();
            let fields: Vec<String> = ja
                .as_object()
                .unwrap()
                .iter()
                .filter(|(f, v)| jb.get(f.as_str()) != Some(v))
                .map(|(f, v)| format!("{f}: {v} / {}", jb[f.as_str()]))
                .collect();
            return Some(format!("{key}: {}", fields.join("; ")));
        }
    }
    if a.2 != b.2 {
        return Some(format!("asks: {:?} / {:?}", a.2, b.2));
    }
    if a.3 != b.3 {
        return Some(format!("order: {} / {} long", a.3.len(), b.3.len()));
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Clean,
    Crash,
}

/// one run: the tape to `stop`, batches every second of tape clock, a
/// device connected from early on; the stop; the restart; the rest of the
/// tape. answers the device and the restarted replay.
fn run(steps: &[Step], stop_at: usize, how: Stop) -> Option<(Device, Replay, u64)> {
    let live = live();
    let mut replay = Replay::new(&live.epoch, &live.build);
    let mut db = database();
    let mut device = Device::default();
    let mut feed: Option<Live> = None;
    let mut interest = Interest::default();
    let mut last_batch_at: Option<i64> = None;
    let mut last_batch_step = 0usize;
    for (n, step) in steps.iter().enumerate().take(stop_at + 1) {
        let at = step.at;
        let copy: Step = serde_json::from_str(&serde_json::to_string(step).unwrap()).unwrap();
        replay.step(copy).unwrap();
        if feed.is_none() && n >= stop_at / 4 && !replay.snapshot().threads.is_empty() {
            interest.thread = stage(&replay);
            let opened = replay.open_with(From::Start, interest.clone(), BTreeMap::new(), at);
            device.take(&opened.frames);
            feed = Some(opened.live);
        }
        if let Some(live) = &mut feed {
            device.drain(live);
        }
        if last_batch_at.is_none_or(|last| at - last >= 1000) && !replay.tail_reads_out() {
            replay.persist(&mut db, false);
            last_batch_at = Some(at);
            last_batch_step = n;
        }
    }
    let stop_clock = steps[stop_at].at;
    match how {
        Stop::Clean => {
            replay.stop(stop_clock);
            if let Some(live) = &mut feed {
                device.drain(live);
            }
            replay.persist(&mut db, true);
        }
        // a crash whose re-delivery would hold a read the tape answers is not one this harness can run
        Stop::Crash if !restartable(steps, last_batch_step + 1, stop_at) => return None,
        Stop::Crash => {}
    }
    let left = device.cursor.clone().expect("the device has a cursor");
    let resumed = replay.restart(&db);
    match how {
        Stop::Clean => assert_eq!(resumed.how, How::Clean),
        Stop::Crash => assert_eq!(resumed.how, How::Crash),
    }
    let reserved_head = replay.head();
    if how == Stop::Crash {
        // the source re-delivers what follows the persisted cursor
        for step in &steps[last_batch_step + 1..=stop_at] {
            if matches!(step.input, Input::Event { .. } | Input::Host(_)) {
                replay.redeliver(step).unwrap();
            }
        }
    }
    // the device reconnects from its cursor, its open thread with its `left`
    let since: BTreeMap<String, u64> = interest
        .thread
        .iter()
        .map(|k| (k.clone(), left.seq))
        .collect();
    let before = (device.resets, device.catchups, device.stale.len());
    let whole_before = device.whole;
    let opened = replay.open_with(From::At(left), interest, since, stop_clock + 1);
    device.take(&opened.frames);
    let mut live = opened.live;
    let after_open = (device.resets, device.catchups, device.stale.len());
    assert_eq!(after_open.0, before.0, "the device got no reset");
    if how == Stop::Clean {
        assert_eq!(
            after_open, before,
            "a clean restart: no catch-up, no stale thread, no read"
        );
        assert_eq!(
            opened.frames.len(),
            4,
            "a clean restart: hello, the colour map, the away list, caught"
        );
    }
    if how == Stop::Crash {
        assert!(
            device.whole > whole_before,
            "a crash: the keys the restart moved come whole"
        );
    }
    let at = end(steps);
    for step in &steps[stop_at + 1..] {
        let copy: Step = serde_json::from_str(&serde_json::to_string(step).unwrap()).unwrap();
        replay.step(copy).unwrap();
        device.drain(&mut live);
    }
    replay.flush_deltas(at + 1000);
    replay.flush_tails(at + 2000);
    device.drain(&mut live);
    Some((device, replay, reserved_head))
}

fn stops(steps: &[Step]) -> Vec<usize> {
    let n = steps.len();
    SEEDS
        .iter()
        .filter_map(|&seed| {
            // a stop with a short window behind it that holds no read
            (0..64)
                .map(|k| n / 8 + seeded(seed + k, n * 3 / 4))
                .find(|&stop| restartable(steps, stop.saturating_sub(40), stop))
        })
        .collect()
}

#[test]
fn protocol3_a_clean_restart_costs_a_connected_device_nothing() {
    let steps = tape();
    let at = end(&steps);
    let reference = overview(&uninterrupted(tape(), at));
    let points = stops(&steps);
    assert!(points.len() >= 3, "enough stops: {points:?}");
    for stop in points {
        let (device, replay, _) = run(&steps, stop, Stop::Clean).expect("a clean stop always runs");
        // the one reset is the device's first connection, before the stop
        assert_eq!(device.resets, 1, "stop {stop}: no reset across the restart");
        if let Some(apart) = apart(&client_overview(&device.client), &overview(&replay)) {
            panic!("stop {stop}: the device parts from the restarted model at {apart}");
        }
        if let Some(apart) = apart(&overview(&replay), &reference) {
            panic!(
                "stop {stop}: the restarted model parts from the run that never stopped at {apart}"
            );
        }
    }
}

#[test]
fn protocol3_a_crash_costs_each_key_one_whole_frame_and_each_thread_one_missed_etag() {
    let steps = tape();
    let at = end(&steps);
    let reference = overview(&uninterrupted(tape(), at));
    let points = stops(&steps);
    assert!(points.len() >= 3, "enough stops: {points:?}");
    let mut ran = 0;
    for stop in points {
        let Some((device, replay, reserved)) = run(&steps, stop, Stop::Crash) else {
            continue;
        };
        ran += 1;
        assert_eq!(device.resets, 1, "stop {stop}: no reset across the crash");
        if let Some(apart) = apart(&client_overview(&device.client), &overview(&replay)) {
            panic!("stop {stop}: the device parts from the restarted model at {apart}");
        }
        if let Some(apart) = apart(&overview(&replay), &reference) {
            panic!(
                "stop {stop}: the restarted model parts from the run that never stopped at {apart}"
            );
        }
        // every thread the restart kept misses its etag once: its versions are at or past the mark
        for key in reference.1.keys() {
            if let Some((v, rv)) = replay.versions(key) {
                assert!(
                    v >= reserved && rv >= reserved,
                    "stop {stop}: {key} at v {v}, rv {rv}, mark {reserved}"
                );
            }
        }
    }
    assert!(ran >= 2, "crashes run: {ran}");
}
