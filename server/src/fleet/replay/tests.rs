//! protocol 3, replayed from the recording contract 1 left (docs/protocol.md,
//! section 16).
//!
//! `server/goldens/contract1/` holds what `bun bench/golden.ts record` took
//! from a live server watching a cmx2 dev daemon: `tape.jsonl.gz`, every
//! input the fleet actor took with its clock, and `live.json.gz`, what that
//! server sent (its epoch and build, and the `/api/needs` answers this file
//! still holds the replay to; its contract 1 journal and streams are kept as
//! the record of what the tape was).
//!
//! `server/goldens/protocol3/` holds what this server journals and answers
//! from that tape: the journal from cursor 0, the views a device gets of it
//! (home, a thread open, a switch between them), `hello` and `reset` for a
//! first connection at the end, resumes inside and beyond the journal, the
//! fleet, the needs and every push, epoch, build and stream id normalised.
//! `BOXBOX_GOLDENS=write cargo test protocol3` rewrites them from the
//! replay; that is for a new recording or a deliberate encoding change,
//! never for a failing test.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::io::Read;
use std::path::PathBuf;

use bytes::Bytes;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{Answer, Replay};
use crate::fleet::From;
use crate::fleet::tape::Step;
use crate::journal::{Cursor, Journal};
use crate::push::Asked;
use crate::push::payload::Payload;
use crate::wire::patch;
use crate::wire::{
    Agent, Ask, Change, Control, Fleet, Interest, JournalEntry, PROTOCOL, ResetReason, Thread,
};

/// the placeholders an epoch, a build and a stream id normalise to.
const EPOCH: &str = "EPOCH";
const BUILD: &str = "BUILD";
const STREAM: &str = "00000000000000000000000000000000";

#[derive(Deserialize)]
struct Live {
    epoch: String,
    build: String,
    needs: Vec<LiveNeeds>,
}

#[derive(Deserialize)]
struct LiveNeeds {
    body: String,
}

fn input(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("goldens/contract1")
        .join(name);
    gunzip_at(&path)
}

fn gunzip_at(path: &std::path::Path) -> String {
    let file = std::fs::File::open(path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}; record it with `bun bench/golden.ts record`",
            path.display()
        )
    });
    let mut text = String::new();
    flate2::read::GzDecoder::new(file)
        .read_to_string(&mut text)
        .unwrap();
    text
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("goldens/protocol3")
}

fn tape() -> Vec<Step> {
    input("tape.jsonl.gz")
        .lines()
        .enumerate()
        .map(|(n, line)| {
            serde_json::from_str(line).unwrap_or_else(|e| panic!("tape line {}: {e}", n + 1))
        })
        .collect()
}

fn live() -> Live {
    serde_json::from_str(&input("live.json.gz")).unwrap()
}

/// the clock of the tape's last step, for the queries asked after it.
fn end(steps: &[Step]) -> i64 {
    steps.last().map_or(0, |s| s.at)
}

/// the tape replayed whole into a fresh actor at today's tail pace, and the
/// actor's clock run a second past its end, so no text waits for its batch.
fn replayed(live: &Live, steps: Vec<Step>) -> Replay {
    let at = end(&steps);
    let mut replay = Replay::new(&live.epoch, &live.build);
    for step in steps {
        replay.step(step).unwrap();
    }
    replay.flush_deltas(at + 1000);
    replay
}

/// the same at the tail pace the tape was recorded at.
fn recorded(live: &Live, steps: Vec<Step>) -> Replay {
    let at = end(&steps);
    let mut replay = Replay::new(&live.epoch, &live.build).at_recorded_pace();
    for step in steps {
        replay.step(step).unwrap();
    }
    replay.flush_deltas(at + 1000);
    replay
}

/// a stream's text with its epoch, build and stream id as placeholders, so
/// a server started at another time compares equal.
fn normalise(text: &str, epoch: &str, build: &str) -> String {
    let text = text
        .replace(
            &format!("\"epoch\":\"{epoch}\""),
            &format!("\"epoch\":\"{EPOCH}\""),
        )
        .replace(
            &format!("\"build\":\"{build}\""),
            &format!("\"build\":\"{BUILD}\""),
        )
        .replace(&format!("{epoch}:"), &format!("{EPOCH}:"));
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(at) = rest.find("\"stream\":\"") {
        let (before, after) = rest.split_at(at + "\"stream\":\"".len());
        out.push_str(before);
        out.push_str(STREAM);
        rest = &after[after.find('"').unwrap_or(0)..];
    }
    out.push_str(rest);
    out
}

fn joined(frames: &[Bytes]) -> String {
    frames
        .iter()
        .map(|f| std::str::from_utf8(f).unwrap())
        .collect()
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .fold(String::new(), |mut hex, b| {
            let _ = write!(hex, "{b:02x}");
            hex
        })
}

/// holds `actual` against `protocol3/<name>`, or writes it there when
/// `BOXBOX_GOLDENS=write`. a name ending `.gz` is kept compressed.
fn golden(name: &str, actual: &str) {
    let path = dir().join(name);
    let zipped = std::path::Path::new(name)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gz"));
    if std::env::var("BOXBOX_GOLDENS").as_deref() == Ok("write") {
        std::fs::create_dir_all(dir()).unwrap();
        if zipped {
            let mut out = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
            std::io::Write::write_all(&mut out, actual.as_bytes()).unwrap();
            std::fs::write(&path, out.finish().unwrap()).unwrap();
        } else {
            std::fs::write(&path, actual).unwrap();
        }
        return;
    }
    let expected = if zipped {
        gunzip_at(&path)
    } else {
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    };
    assert!(
        expected == actual,
        "{name} differs from its golden (sha256 {} recorded, {} now)",
        digest(&expected),
        digest(actual)
    );
}

/// the json object a frame carries.
fn data(frame: &Bytes) -> serde_json::Value {
    let text = std::str::from_utf8(frame).unwrap();
    let json: String = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&json).unwrap()
}

fn entry(frame: &Bytes) -> JournalEntry {
    serde_json::from_value(data(frame)).unwrap()
}

/// what a client holds of the overview, built only from journal entries.
#[derive(Default, Clone)]
struct Client {
    agents: BTreeMap<String, Agent>,
    threads: BTreeMap<String, Thread>,
    asks: BTreeMap<(String, String), Ask>,
    order: Vec<String>,
}

impl Client {
    /// applies one entry by the client's rules; an entry that cannot apply
    /// is a protocol error.
    fn apply(&mut self, change: Change) -> Result<(), String> {
        match change {
            Change::Agent { agent } => {
                self.agents.insert(agent.key.clone(), agent);
            }
            Change::AgentRemoved { agent } => {
                self.agents.remove(&agent);
            }
            Change::Thread { thread } => {
                self.threads.insert(thread.key.clone(), thread);
            }
            Change::ThreadPatch(p) => {
                let base = self.threads.get(&p.key).ok_or_else(|| {
                    format!("a patch for {}, which the client does not hold", p.key)
                })?;
                let next = patch::apply_thread(base, &p).map_err(|e| e.to_string())?;
                self.threads.insert(p.key.clone(), next);
            }
            Change::ThreadRemoved { key } => {
                self.threads.remove(&key);
            }
            Change::Ask { ask } => {
                self.asks.insert((ask.agent.clone(), ask.id.clone()), ask);
            }
            Change::AskSettled(settled) => {
                self.asks.remove(&(settled.agent, settled.id));
            }
            Change::Order { keys } => self.order = keys,
            Change::OrderPatch { ops } => {
                self.order = patch::apply_order(&self.order, &ops).map_err(|e| e.to_string())?;
            }
            // transcript entries, and a reset of one, leave the overview as it is
            Change::ThreadReset { .. }
            | Change::Message { .. }
            | Change::Part { .. }
            | Change::Delta { .. }
            | Change::MessageRemoved { .. }
            | Change::Reactions { .. }
            | Change::Btw { .. }
            | Change::BtwDelta { .. } => {}
        }
        Ok(())
    }
}

/// the tape through the actor, every journal entry applied in order to an
/// empty client after each step: the client equals the model's snapshot
/// at every step (a thread whose streamed text waits for the 500 ms pace in
/// all but its tail, which the next entry for it carries), and no entry
/// fails to apply (`docs/protocol.md`, section 3, a frame that cannot apply).
#[test]
fn protocol3_the_journal_applied_in_order_always_equals_the_model() {
    let live = live();
    let steps = tape();
    let at = end(&steps);
    let mut replay = Replay::new(&live.epoch, &live.build);
    let mut client = Client::default();
    let (mut seen, mut applied, mut held_steps, mut checks) = (0u64, 0usize, 0usize, 0usize);
    let mut quiet = 0usize;
    let mut check = |replay: &Replay, client: &Client, step: usize| {
        let fleet = replay.snapshot();
        let held = replay.held();
        let agents: BTreeMap<&str, &Agent> =
            fleet.agents.iter().map(|a| (a.key.as_str(), a)).collect();
        assert_eq!(
            agents,
            client.agents.iter().map(|(k, a)| (k.as_str(), a)).collect(),
            "agents at step {step}"
        );
        let asks: BTreeMap<(&str, &str), &Ask> = fleet
            .asks
            .iter()
            .map(|a| ((a.agent.as_str(), a.id.as_str()), a))
            .collect();
        assert_eq!(
            asks,
            client
                .asks
                .iter()
                .map(|((g, i), a)| ((g.as_str(), i.as_str()), a))
                .collect(),
            "asks at step {step}"
        );
        assert_eq!(fleet.order, client.order, "order at step {step}");
        let keys: Vec<&str> = fleet.threads.iter().map(|t| t.key.as_str()).collect();
        assert_eq!(
            keys,
            client
                .threads
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            "thread keys at step {step}"
        );
        for thread in &fleet.threads {
            let held_by_client = &client.threads[&thread.key];
            let mut expected = thread.clone();
            let mut client_side = held_by_client.clone();
            if held.contains(&thread.key) {
                expected.tail.clone_from(&held_by_client.tail);
            } else if expected != client_side {
                // a tail item that renders nothing moves without an entry: the next one carries it
                expected.tail.retain(renders);
                client_side.tail.retain(renders);
                quiet += 1;
            }
            assert!(
                expected == client_side,
                "{} at step {step}: {}",
                thread.key,
                fields_apart(&expected, held_by_client)
            );
        }
        held.len()
    };
    for (n, step) in steps.into_iter().enumerate() {
        replay.step(step).unwrap();
        for frame in replay.journal_after(seen) {
            let entry = entry(&frame);
            seen = entry.seq;
            client
                .apply(entry.change)
                .unwrap_or_else(|e| panic!("seq {seen} at step {n}: {e}"));
            applied += 1;
        }
        held_steps += usize::from(check(&replay, &client, n) > 0);
        checks += 1;
    }
    // the clock runs on: what was held goes out, and then every thread is whole
    replay.flush_deltas(at + 1000);
    replay
        .step(Step {
            at: at + 1000,
            input: crate::fleet::tape::Input::FlushTails,
        })
        .unwrap();
    for frame in replay.journal_after(seen) {
        client.apply(entry(&frame).change).unwrap();
        applied += 1;
    }
    assert_eq!(
        check(&replay, &client, checks),
        0,
        "nothing held at the end"
    );
    println!(
        "{checks} steps, {applied} entries applied with no fault; {held_steps} steps had streamed text waiting for the pace; {quiet} thread checks equal only in the tail items that render; {} threads, {} asks, {} agents at the end",
        client.threads.len(),
        client.asks.len(),
        client.agents.len()
    );
    assert!(applied > 0);
}

/// whether a window draws a tail item: thinking never, text once it has words.
fn renders(item: &crate::wire::TailItem) -> bool {
    match item.kind {
        crate::wire::TailKind::Reasoning => false,
        crate::wire::TailKind::Text => !item.text.trim().is_empty(),
        _ => true,
    }
}

/// the fields two threads differ in, each as the model and the client hold it.
fn fields_apart(model: &Thread, client: &Thread) -> String {
    let (serde_json::Value::Object(a), serde_json::Value::Object(b)) = (
        serde_json::to_value(model).unwrap(),
        serde_json::to_value(client).unwrap(),
    ) else {
        unreachable!()
    };
    let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter(|k| a.get(*k) != b.get(*k))
        .map(|k| format!("{k}: model {:?}, client {:?}", a.get(k), b.get(k)))
        .collect::<Vec<_>>()
        .join("; ")
}

/// the thread with the most transcript entries.
fn busiest(entries: &[JournalEntry]) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        if let Some(key) = entry.change.transcript_key() {
            *counts.entry(key).or_default() += 1;
        }
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    counts[0].0.to_owned()
}

/// whether a stream with `thread` open gets `entry`.
fn shows(entry: &JournalEntry, thread: Option<&str>) -> bool {
    entry
        .change
        .transcript_key()
        .is_none_or(|key| Some(key) == thread)
}

fn control(id: Option<u64>, control: &Control) -> String {
    let json = serde_json::to_vec(control).unwrap();
    let frame = crate::journal::sse_frame(id.map(|s| format!("{EPOCH}:{s}")).as_deref(), &json);
    String::from_utf8(frame.to_vec()).unwrap()
}

fn hello(interest: Interest) -> String {
    control(
        None,
        &Control::Hello {
            protocol: PROTOCOL,
            epoch: EPOCH.into(),
            head: 0,
            build: BUILD.into(),
            stream: STREAM.into(),
            interest,
        },
    )
}

/// a first stream at cursor 0: hello, the colour map and an empty reset.
fn opening(interest: Interest) -> String {
    let colours = serde_json::to_vec(&crate::wire::ColourFrame::Colours {
        colours: Vec::new(),
    })
    .unwrap();
    hello(interest)
        + std::str::from_utf8(&crate::journal::sse_frame(None, &colours)).unwrap()
        + &control(
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

/// the journal from cursor 0, and the views a device gets of it before
/// interest filters the stream for it: home (the overview only), the
/// busiest thread open, and home switching to that thread mid-tape with
/// `since` a quarter in (its entries in between in a `catchup` frame). the
/// app replays these until the server sends them itself.
#[test]
fn protocol3_goldens_the_journal_and_the_views_a_device_gets() {
    let live = live();
    let replay = replayed(&live, tape());
    let frames = replay.journal();
    let journal = normalise(&joined(&frames), &live.epoch, &live.build);
    let entries: Vec<JournalEntry> = frames.iter().map(entry).collect();
    let text: Vec<String> = frames
        .iter()
        .map(|f| normalise(std::str::from_utf8(f).unwrap(), &live.epoch, &live.build))
        .collect();
    let thread = busiest(&entries);
    let head = replay.head();

    let home = opening(Interest::default())
        + &entries
            .iter()
            .zip(&text)
            .filter(|(e, _)| shows(e, None))
            .map(|(_, t)| t.as_str())
            .collect::<String>();
    let open = Interest {
        thread: Some(thread.clone()),
        under: Vec::new(),
        holds: Vec::new(),
    };
    let opened = opening(open)
        + &entries
            .iter()
            .zip(&text)
            .filter(|(e, _)| shows(e, Some(&thread)))
            .map(|(_, t)| t.as_str())
            .collect::<String>();
    let (since, at) = (head / 4, head / 2);
    let mut switch = opening(Interest::default())
        + &entries
            .iter()
            .zip(&text)
            .filter(|(e, _)| e.seq <= at && shows(e, None))
            .map(|(_, t)| t.as_str())
            .collect::<String>();
    let caught: Vec<JournalEntry> = entries
        .iter()
        .filter(|e| e.seq > since && e.seq <= at && e.change.transcript_key() == Some(&thread))
        .cloned()
        .collect();
    if !caught.is_empty() {
        switch += &control(None, &Control::Catchup { entries: caught });
    }
    switch += &control(
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
    );
    switch += &entries
        .iter()
        .zip(&text)
        .filter(|(e, _)| e.seq > at && shows(e, Some(&thread)))
        .map(|(_, t)| t.as_str())
        .collect::<String>();
    println!(
        "journal {} entries (seq to {head}), {} bytes; home {} bytes; {thread} open {} bytes",
        entries.len(),
        journal.len(),
        home.len(),
        opened.len()
    );
    golden("journal.sse.gz", &journal);
    golden("home.sse.gz", &home);
    golden("thread.sse.gz", &opened);
    golden("switch.sse.gz", &switch);
}

/// the repo of each thread a page's frames show whole, as `agent:root`.
fn repos_shown(frames: &[Bytes]) -> Vec<String> {
    let mut repos = Vec::new();
    for frame in frames {
        let value = data(frame);
        let threads: Vec<&serde_json::Value> = match value["type"].as_str() {
            Some("thread") => vec![&value["thread"]],
            Some("reset") => value["fleet"]["threads"]
                .as_array()
                .unwrap()
                .iter()
                .collect(),
            _ => continue,
        };
        for thread in threads {
            if let Some(root) = thread["place"]["root"].as_str() {
                repos.push(format!("{}:{root}", thread["agent"].as_str().unwrap()));
            }
        }
    }
    repos
}

#[test]
fn protocol3_every_stream_gets_the_colour_map_before_any_thread_from_a_reset_or_a_resume() {
    let live = live();
    let steps = tape();
    let at = end(&steps);
    let mut replay = Replay::colouring(&live.epoch, &live.build);
    for step in steps {
        replay.step(step).unwrap();
    }
    for from in [
        From::Start,
        From::At(Cursor {
            epoch: live.epoch.clone(),
            seq: 0,
        }),
    ] {
        let frames = replay.open(from, at);
        let second = std::str::from_utf8(&frames[1]).unwrap();
        assert!(
            second.starts_with("data: {\"type\":\"colours\",\"colours\":["),
            "hello, then the map: {}",
            &second[..second.len().min(80)]
        );
        let map = data(&frames[1]);
        let given: Vec<String> = map["colours"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                format!(
                    "{}:{}",
                    c["host"].as_str().unwrap(),
                    c["root"].as_str().unwrap()
                )
            })
            .collect();
        let shown = repos_shown(&frames[2..]);
        assert!(!shown.is_empty());
        for repo in shown {
            assert!(given.contains(&repo), "{repo} shows without its colour");
        }
    }
}

#[test]
fn protocol3_replaying_the_tape_twice_gives_the_same_journal_bytes() {
    let live = live();
    let first = joined(&replayed(&live, tape()).journal());
    let second = joined(&replayed(&live, tape()).journal());
    println!(
        "two replays: {} and {} bytes, sha256 {} and {}",
        first.len(),
        second.len(),
        digest(&first),
        digest(&second)
    );
    assert!(
        first == second,
        "two replays of one tape journaled different bytes"
    );
}

/// every page of every stream the bench opened while the tape ran is
/// protocol 3: a first page leads with `hello` and the colour map, and
/// every frame decodes as a control frame or a journal entry.
#[test]
fn protocol3_every_stream_the_bench_opened_speaks_protocol_3() {
    let live = live();
    let replay = replayed(&live, tape());
    let mut pages = 0;
    for answer in &replay.answers {
        let Answer::Page { stream, frames } = answer else {
            continue;
        };
        pages += 1;
        let hello = data(&frames[0]);
        assert_eq!(hello["type"], "hello", "stream {stream:08x}");
        assert_eq!(hello["protocol"], 3);
        assert_eq!(data(&frames[1])["type"], "colours");
        for frame in frames {
            let value = data(frame);
            let entry = value.get("seq").is_some()
                && !matches!(
                    value["type"].as_str(),
                    Some("reset" | "caught" | "interest")
                );
            let decoded = if entry {
                serde_json::from_value::<JournalEntry>(value.clone()).is_ok()
            } else {
                serde_json::from_value::<Control>(value.clone()).is_ok()
                    || serde_json::from_value::<crate::wire::ColourFrame>(value.clone()).is_ok()
            };
            assert!(decoded, "stream {stream:08x}: {}", value["type"]);
        }
    }
    println!("{pages} pages of the bench's streams decode as protocol 3");
    assert!(pages > 0);
}

/// the needs do not ride the device protocol: every `/api/needs` body the
/// bench read is still what the replay answers (its `x-boxbox-seq` names a
/// position in another journal now, so it is not compared).
#[test]
fn protocol3_every_needs_answer_the_bench_read_is_what_the_replay_answers() {
    let live = live();
    let replay = recorded(&live, tape());
    let needs: Vec<&Vec<u8>> = replay
        .answers
        .iter()
        .filter_map(|a| match a {
            Answer::Needs { body, .. } => Some(body),
            _ => None,
        })
        .collect();
    assert_eq!(needs.len(), live.needs.len(), "/api/needs answers");
    for (n, (body, theirs)) in needs.iter().zip(&live.needs).enumerate() {
        assert!(
            body.as_slice() == theirs.body.as_bytes(),
            "/api/needs body {n} differs"
        );
    }
    println!("{} /api/needs answers match the replay", needs.len());
}

#[test]
fn protocol3_goldens_hello_and_reset_for_a_first_connection_at_the_end_of_the_session() {
    let live = live();
    let steps = tape();
    let at = end(&steps);
    let mut replay = replayed(&live, steps);
    let frames = replay.open(From::Start, at);
    assert_eq!(frames.len(), 3, "hello, the colour map, then reset");
    golden(
        "hello-reset.sse.gz",
        &normalise(&joined(&frames), &live.epoch, &live.build),
    );
}

#[test]
fn protocol3_goldens_cursor_resumes_inside_and_beyond_the_journal() {
    let live = live();
    let steps = tape();
    let at = end(&steps);
    let mut replay = replayed(&live, steps);
    let head = replay.head();
    let cursor = |seq| {
        From::At(Cursor {
            epoch: live.epoch.clone(),
            seq,
        })
    };
    // inside: hello, the colour map, each key that moved in the last 20
    // entries once whole at its newest seq, then caught at the head
    let inside = replay.open(cursor(head.saturating_sub(20)), at);
    let kinds: Vec<String> = inside
        .iter()
        .map(|f| data(f)["type"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(kinds.last().map(String::as_str), Some("caught"));
    assert!(inside.len() <= 23, "{kinds:?}");
    let ids: Vec<u64> = inside[2..]
        .iter()
        .map(|f| data(f)["seq"].as_u64().unwrap())
        .collect();
    assert!(
        ids.windows(2).all(|w| w[0] < w[1] || w[1] == head),
        "{ids:?}"
    );
    golden(
        "resume-inside.sse",
        &normalise(&joined(&inside), &live.epoch, &live.build),
    );
    // at the head: hello, the colour map and caught, then live
    let at_head = replay.open(cursor(head), at);
    assert_eq!(at_head.len(), 3);
    golden(
        "resume-at-head.sse",
        &normalise(&joined(&at_head), &live.epoch, &live.build),
    );
    // beyond the head: a cursor this ring never issued is reset as invalid
    let ahead = replay.open(cursor(head + 5), at);
    assert!(joined(&ahead).contains("\"reason\":\"invalid\""));
    golden(
        "resume-ahead.sse.gz",
        &normalise(&joined(&ahead), &live.epoch, &live.build),
    );
    // another epoch: reset with reason epoch, never a replay
    let other = replay.open(
        From::At(Cursor {
            epoch: "000000000000".into(),
            seq: 1,
        }),
        at,
    );
    assert!(joined(&other).contains("\"reason\":\"epoch\""));
    golden(
        "resume-epoch.sse.gz",
        &normalise(&joined(&other), &live.epoch, &live.build),
    );
}

/// a cursor older than the ring still catches up the overview (it is built
/// from what each key holds, not the ring), and a thread it shows whose
/// entries since its `since` the ring lost is stale; a cursor below the
/// tombstone floor is reset as expired.
#[test]
fn protocol3_goldens_a_resume_from_before_the_ring_catches_up_and_one_below_the_tombstones_is_expired()
 {
    let live = live();
    let steps = tape();
    let at = end(&steps);
    // the same session into a ring that keeps only the last 500 entries
    let mut replay = Replay::with_journal(
        Journal::with_caps(live.epoch.clone(), usize::MAX, 500),
        &live.build,
    );
    for step in steps {
        replay.step(step).unwrap();
    }
    replay.flush_deltas(at + 1000);
    assert!(replay.floor() > 1, "the small ring evicted");
    let thread = busiest(&replay.journal().iter().map(entry).collect::<Vec<_>>());
    let caught = replay
        .open_with(
            From::At(Cursor {
                epoch: live.epoch.clone(),
                seq: 1,
            }),
            Interest {
                thread: Some(thread.clone()),
                under: Vec::new(),
                holds: Vec::new(),
            },
            BTreeMap::from([(thread.clone(), 1)]),
            at,
        )
        .frames;
    let kinds: Vec<String> = caught
        .iter()
        .map(|f| data(f)["type"].as_str().unwrap().to_owned())
        .collect();
    assert!(!kinds.contains(&"reset".to_owned()), "{kinds:?}");
    assert_eq!(&kinds[kinds.len() - 2..], ["thread.stale", "caught"]);
    replay.raise_gone_floor(2);
    let expired = replay.open(
        From::At(Cursor {
            epoch: live.epoch.clone(),
            seq: 1,
        }),
        at,
    );
    assert!(joined(&expired).contains("\"reason\":\"expired\""));
    golden(
        "resume-expired.sse.gz",
        &normalise(&joined(&expired), &live.epoch, &live.build),
    );
}

#[test]
fn protocol3_goldens_the_fleet_and_the_needs_at_the_end_of_the_session() {
    let live = live();
    let mut steps = tape();
    let at = end(&steps);
    for query in [
        crate::fleet::tape::Command::Snapshot,
        crate::fleet::tape::Command::Needs,
    ] {
        steps.push(Step {
            at,
            input: crate::fleet::tape::Input::Command(query),
        });
    }
    let replay = replayed(&live, steps);
    let mut answers = replay.answers.iter().rev();
    let Some(Answer::Needs { body, seq }) = answers.next() else {
        panic!("the last answer is the needs")
    };
    let Some(Answer::Snapshot(fleet)) = answers.next() else {
        panic!("the one before is the fleet")
    };
    let decoded: Fleet = serde_json::from_slice(fleet).unwrap();
    assert!(!decoded.threads.is_empty() && !decoded.agents.is_empty());
    golden("fleet.json.gz", std::str::from_utf8(fleet).unwrap());
    golden("needs.json", std::str::from_utf8(body).unwrap());
    golden(
        "needs.seq",
        &normalise(&format!("{seq}\n"), &live.epoch, &live.build),
    );
}

#[test]
fn protocol3_goldens_push_payloads_and_titles_for_every_notice_of_the_session() {
    let recorded = live();
    let replay = replayed(&recorded, tape());
    let mut lines = Vec::new();
    for pushed in &replay.pushed {
        let line = match &pushed.asked {
            Asked::Notify(notice) => {
                let payload = Payload::new(notice, "golden-device", "iphone", pushed.at);
                String::from_utf8(payload.to_bytes().expect("fits a push")).unwrap()
            }
            Asked::Continued(thread) => {
                serde_json::json!({ "continued": thread.key() }).to_string()
            }
            Asked::Served { id, by, how } => {
                serde_json::json!({ "served": id, "by": by, "how": how }).to_string()
            }
        };
        lines.push(line);
    }
    let notices = replay
        .pushed
        .iter()
        .filter(|p| matches!(p.asked, Asked::Notify(_)))
        .count();
    println!("{} pushes asked, {notices} of them notices", lines.len());
    assert!(notices > 0, "the session raised no notice");
    golden("push.jsonl", &(lines.join("\n") + "\n"));
}

/// what the recorded session costs a device on the wire, plain and through
/// one gzip context sync-flushed per write (`http/compress.rs`, `Framed`),
/// a write being every frame one tape step journaled: fewer and larger
/// writes than a live stream batches, so the ratio here is a floor.
#[test]
fn protocol3_the_recorded_session_costs_a_device_several_times_fewer_bytes_through_gzip() {
    let live = live();
    let steps = tape();
    let (start, finish) = (steps.first().unwrap().at, steps.last().unwrap().at);
    let mut replay = Replay::new(&live.epoch, &live.build);
    let mut gzip = crate::http::compress::Framed::new();
    let mut decoder = flate2::write::GzDecoder::new(Vec::new());
    let (mut head, mut plain, mut wire, mut writes) = (replay.head(), 0usize, 0usize, 0usize);
    for step in steps {
        replay.step(step).unwrap();
        if replay.head() == head {
            continue;
        }
        let batch: Vec<u8> = replay.journal_after(head).concat();
        head = replay.head();
        let zipped = gzip.batch(&batch).unwrap();
        std::io::Write::write_all(&mut decoder, &zipped).unwrap();
        std::io::Write::flush(&mut decoder).unwrap();
        assert_eq!(
            std::mem::take(decoder.get_mut()),
            batch,
            "a write did not decode on arrival"
        );
        (plain, wire, writes) = (plain + batch.len(), wire + zipped.len(), writes + 1);
    }
    #[allow(clippy::cast_precision_loss)]
    let minutes = (finish - start) as f64 / 60_000.0;
    #[allow(clippy::cast_precision_loss)]
    let (plain_per_minute, wire_per_minute) = (plain as f64 / minutes, wire as f64 / minutes);
    println!(
        "{writes} writes over {minutes:.2} min: plain {plain} bytes ({plain_per_minute:.0}/min), gzip {wire} bytes ({wire_per_minute:.0}/min), {:.1}x",
        plain_per_minute / wire_per_minute
    );
    assert!(wire * 4 < plain, "gzip {wire} of {plain}");
}

/// each part's streamed text, joined in journal order.
type Streamed = BTreeMap<(String, String), String>;

/// each thread's last state and how many entries it took.
type Cadence = BTreeMap<String, (Option<Thread>, usize)>;

/// a journal's entries, applied: each thread's final state and how many
/// entries it took, each part's streamed text whole (any other entry takes
/// the pending deltas out first, so a thread going out more often cuts the
/// same text into more batches), and every other entry, seqs out.
fn by_cadence(frames: &[Bytes]) -> (Vec<String>, Cadence, Streamed) {
    let mut client = Client::default();
    let mut others = Vec::new();
    let mut streamed = Streamed::new();
    let mut threads = Cadence::new();
    for frame in frames {
        let entry = entry(frame);
        let key = match &entry.change {
            Change::Thread { thread } => Some(thread.key.clone()),
            Change::ThreadPatch(p) => Some(p.key.clone()),
            _ => None,
        };
        if let Change::Delta {
            key,
            part_id,
            delta,
            ..
        } = &entry.change
        {
            streamed
                .entry((key.clone(), part_id.clone()))
                .or_default()
                .push_str(delta);
            continue;
        }
        if let Some(key) = key {
            client.apply(entry.change).unwrap();
            let slot = threads.entry(key.clone()).or_default();
            slot.0 = client.threads.get(&key).cloned();
            slot.1 += 1;
        } else {
            others.push(serde_json::to_string(&entry.change).unwrap());
            client.apply(entry.change).unwrap();
        }
    }
    (others, threads, streamed)
}

/// today's tail pace against the pace the tape was recorded at: the same
/// entries in the same order but for threads, which go out less often, and
/// each thread's last state the same.
#[test]
fn protocol3_the_home_overview_pace_changes_only_how_often_a_thread_goes_out() {
    let live = live();
    let slow = replayed(&live, tape()).journal();
    let fast = recorded(&live, tape()).journal();
    let (slow_others, slow_threads, slow_text) = by_cadence(&slow);
    let (fast_others, fast_threads, fast_text) = by_cadence(&fast);
    assert!(slow_text == fast_text, "a part streamed other text");
    if let Some(at) = slow_others
        .iter()
        .zip(&fast_others)
        .position(|(a, b)| a != b)
    {
        panic!(
            "an entry other than a thread's moved at {at}:\n{}\n{}",
            slow_others[at], fast_others[at]
        );
    }
    assert_eq!(slow_others.len(), fast_others.len());
    assert_eq!(
        slow_threads.keys().collect::<Vec<_>>(),
        fast_threads.keys().collect::<Vec<_>>()
    );
    for (key, (last, count)) in &slow_threads {
        let (recorded, recorded_count) = &fast_threads[key];
        assert_eq!(last, recorded, "{key} ends elsewhere");
        assert!(count <= recorded_count, "{key} went out more often");
    }
    let (slow_count, fast_count) = (
        slow_threads.values().map(|t| t.1).sum::<usize>(),
        fast_threads.values().map(|t| t.1).sum::<usize>(),
    );
    println!(
        "thread entries: {fast_count} at {} ms, {slow_count} at {} ms; {} other entries alike; journal {} to {} bytes",
        super::RECORDED_TAIL_EVERY_MS,
        crate::fleet::model::TAIL_EVERY_MS,
        slow_others.len(),
        joined(&fast).len(),
        joined(&slow).len()
    );
    assert!(slow_count < fast_count);
}

mod proofs;
mod restart;
