//! contract 1, recorded before the seam (docs/plan.md, m9's gate).
//!
//! `server/goldens/contract1/` holds what `bun bench/golden.ts record`
//! took from a live server on today's main watching a cmx2 dev daemon:
//!
//! - `tape.jsonl.gz`: every input the fleet actor took, with its clock.
//! - `live.json.gz`: what that live server sent: its epoch and build, the
//!   whole contract 1 journal as a stream from cursor 0 delivered it, and
//!   every stream, `/api/fleet` and `/api/needs` answer the bench asked for
//!   while the tape ran.
//! - `golden/`: what today's server answers at the end of the tape (the
//!   `hello` and `reset`, resumes inside and beyond the journal, the fleet,
//!   the needs, every push it asked for), epoch and build normalised.
//!
//! the tests replay the tape and hold the result against both. after the
//! seam they must pass unchanged, with only `Replay::upstream` moved.
//! `BOXBOX_GOLDENS=write cargo test goldens` rewrites `golden/` from the
//! replay; that is for a new recording, never for a failing test.

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

/// the placeholders an epoch and a build normalise to.
const EPOCH: &str = "EPOCH";
const BUILD: &str = "BUILD";

#[derive(Deserialize)]
struct Live {
    epoch: String,
    build: String,
    /// every journal frame, as the stream sent them, concatenated.
    journal: String,
    /// each stream the bench opened, in order: the bytes it read before it
    /// closed (`None` for one it did not keep, the board's client).
    streams: Vec<Option<String>>,
    fleet: Vec<String>,
    needs: Vec<LiveNeeds>,
}

#[derive(Deserialize)]
struct LiveNeeds {
    body: String,
    seq: String,
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("goldens/contract1")
}

fn gunzip(name: &str) -> String {
    let path = dir().join(name);
    let file = std::fs::File::open(&path).unwrap_or_else(|e| {
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

fn tape() -> Vec<Step> {
    gunzip("tape.jsonl.gz")
        .lines()
        .enumerate()
        .map(|(n, line)| {
            serde_json::from_str(line).unwrap_or_else(|e| panic!("tape line {}: {e}", n + 1))
        })
        .collect()
}

fn live() -> Live {
    serde_json::from_str(&gunzip("live.json.gz")).unwrap()
}

/// the tape replayed whole into a fresh actor, at today's tail pace.
fn replayed(live: &Live, steps: Vec<Step>) -> Replay {
    let mut replay = Replay::new(&live.epoch, &live.build);
    for step in steps {
        replay.step(step).unwrap();
    }
    replay
}

/// the same at the tail pace the tape was recorded at, to be held against
/// what the live server sent.
fn recorded(live: &Live, steps: Vec<Step>) -> Replay {
    let mut replay = Replay::new(&live.epoch, &live.build).at_recorded_pace();
    for step in steps {
        replay.step(step).unwrap();
    }
    replay
}

/// a stream's text with its epoch and build as placeholders, so a server
/// started at another time (or after the seam) compares equal.
fn normalise(text: &str, epoch: &str, build: &str) -> String {
    text.replace(&format!("id: {epoch}:"), &format!("id: {EPOCH}:"))
        .replace(
            &format!("\"epoch\":\"{epoch}\""),
            &format!("\"epoch\":\"{EPOCH}\""),
        )
        .replace(
            &format!("\"build\":\"{build}\""),
            &format!("\"build\":\"{BUILD}\""),
        )
        .replace(&format!("{epoch}:"), &format!("{EPOCH}:"))
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

/// holds `actual` against `golden/<name>`, or writes it there when
/// `BOXBOX_GOLDENS=write`. a name ending `.gz` is kept compressed: the
/// snapshots of a thousand threads are most of a megabyte each.
fn golden(name: &str, actual: &str) {
    let path = dir().join("golden").join(name);
    let zipped = std::path::Path::new(name)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gz"));
    if std::env::var("BOXBOX_GOLDENS").as_deref() == Ok("write") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
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
        gunzip(&format!("golden/{name}"))
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

#[test]
fn the_recorded_session_replays_to_the_journal_recorded_live_byte_for_byte() {
    let live = live();
    let steps = tape();
    let count = steps.len();
    let replay = recorded(&live, steps);
    let ours = normalise(&joined(&replay.journal()), &live.epoch, &live.build);
    let theirs = normalise(&live.journal, &live.epoch, &live.build);
    println!(
        "replayed {count} steps: journal {} frames (seq {} to {}), {} bytes, sha256 {}; live sha256 {}",
        replay.journal().len(),
        replay.floor(),
        replay.head(),
        ours.len(),
        digest(&ours),
        digest(&theirs)
    );
    if ours != theirs {
        let first = ours
            .split("\n\n")
            .zip(theirs.split("\n\n"))
            .position(|(a, b)| a != b);
        let at = first.unwrap_or(0);
        panic!(
            "the replayed journal differs from the live one at frame {at}:\nreplayed: {}\nlive:     {}",
            ours.split("\n\n").nth(at).unwrap_or("(none)"),
            theirs.split("\n\n").nth(at).unwrap_or("(none)")
        );
    }
}

/// the tape replayed whole into an actor that gives repos colours, as a
/// fresh server does now.
fn coloured(live: &Live) -> Replay {
    let mut replay = Replay::colouring(&live.epoch, &live.build).at_recorded_pace();
    for step in tape() {
        replay.step(step).unwrap();
    }
    replay
}

#[test]
fn with_colours_given_contract_1_is_still_what_was_recorded_byte_for_byte() {
    let live = live();
    let replay = coloured(&live);
    let ours = normalise(&joined(&replay.journal()), &live.epoch, &live.build);
    assert!(
        ours == normalise(&live.journal, &live.epoch, &live.build),
        "the journal moved"
    );
    let mut fleet = live.fleet.iter();
    let mut streams: Vec<(u32, String)> = Vec::new();
    for answer in &replay.answers {
        match answer {
            Answer::Snapshot(body) => {
                assert!(
                    Some(&body[..]) == fleet.next().map(String::as_bytes),
                    "/api/fleet moved"
                );
            }
            Answer::Page {
                stream,
                first,
                frames,
            } => match streams.iter_mut().rev().find(|(id, _)| id == stream) {
                Some((_, held)) if !first => held.push_str(&joined(frames)),
                _ => streams.push((*stream, joined(frames))),
            },
            Answer::Needs { .. } => {}
        }
    }
    for ((_, ours), theirs) in streams.iter().zip(&live.streams) {
        if let Some(theirs) = theirs {
            assert!(
                theirs.starts_with(ours.as_str()),
                "a stream that did not ask for colours moved"
            );
            assert!(!ours.contains(r#""type":"colour"#), "and it saw no colour");
        }
    }
}

/// the repo of each session a page's frames show, as `host:root`.
fn repos_shown(frames: &[Bytes]) -> Vec<String> {
    let mut repos = Vec::new();
    for frame in frames {
        let text = std::str::from_utf8(frame).unwrap();
        let Some(data) = text.lines().find_map(|l| l.strip_prefix("data: ")) else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_str(data).unwrap();
        let sessions: Vec<&serde_json::Value> = match value["type"].as_str() {
            Some("session") => vec![&value["session"]],
            Some("host.reset") => value["sessions"].as_array().unwrap().iter().collect(),
            Some("reset") => value["fleet"]["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .collect(),
            _ => continue,
        };
        for session in sessions {
            let info = &session["info"];
            let project = info["projectID"].as_str().unwrap();
            let root = if project.starts_with('/') {
                project
            } else {
                info["directory"].as_str().unwrap()
            };
            repos.push(format!("{}:{root}", session["host"].as_str().unwrap()));
        }
    }
    repos
}

#[test]
fn a_stream_that_asks_for_colours_gets_the_map_before_any_session_from_a_reset_or_a_resume() {
    let live = live();
    let steps = tape();
    let at = end(&steps);
    let mut replay = coloured(&live);
    for from in [
        From::Start,
        From::At(Cursor {
            epoch: live.epoch.clone(),
            seq: 0,
        }),
    ] {
        let frames = replay.open_colours(from, at);
        let second = std::str::from_utf8(&frames[1]).unwrap();
        assert!(
            second.starts_with("data: {\"type\":\"colours\",\"colours\":["),
            "hello, then the map: {}",
            &second[..second.len().min(80)]
        );
        assert!(!second.starts_with("id:"), "id-less, outside the journal");
        let map: serde_json::Value =
            serde_json::from_str(second.trim().strip_prefix("data: ").unwrap()).unwrap();
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
fn replaying_the_tape_twice_gives_the_same_journal_bytes() {
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

#[test]
fn every_stream_the_bench_opened_began_with_what_the_replay_answers() {
    let live = live();
    let replay = recorded(&live, tape());
    // a stream's pages, in the order its first page was asked for
    let mut streams: Vec<(u32, String)> = Vec::new();
    for answer in &replay.answers {
        if let Answer::Page {
            stream,
            first,
            frames,
        } = answer
        {
            let text = joined(frames);
            match streams.iter_mut().rev().find(|(id, _)| id == stream) {
                Some((_, held)) if !first => held.push_str(&text),
                _ => streams.push((*stream, text)),
            }
        }
    }
    assert_eq!(
        streams.len(),
        live.streams.len(),
        "the tape and the bench disagree on how many streams opened"
    );
    let mut checked = 0;
    for (n, ((_, ours), theirs)) in streams.iter().zip(&live.streams).enumerate() {
        let Some(theirs) = theirs else { continue };
        assert!(
            theirs.starts_with(ours.as_str()),
            "stream {n}: the live body does not begin with the replayed pages\nreplayed: {}\nlive:     {}",
            &ours[..ours.len().min(400)],
            &theirs[..theirs.len().min(400)]
        );
        checked += 1;
    }
    println!("{checked} live streams match the replay");
    assert!(checked > 0);
}

#[test]
fn every_fleet_and_needs_answer_the_bench_read_is_what_the_replay_answers() {
    let live = live();
    let replay = recorded(&live, tape());
    let fleet: Vec<&Bytes> = replay
        .answers
        .iter()
        .filter_map(|a| match a {
            Answer::Snapshot(body) => Some(body),
            _ => None,
        })
        .collect();
    let needs: Vec<(&Vec<u8>, &String)> = replay
        .answers
        .iter()
        .filter_map(|a| match a {
            Answer::Needs { body, seq } => Some((body, seq)),
            _ => None,
        })
        .collect();
    assert_eq!(fleet.len(), live.fleet.len(), "/api/fleet answers");
    assert_eq!(needs.len(), live.needs.len(), "/api/needs answers");
    for (n, (ours, theirs)) in fleet.iter().zip(&live.fleet).enumerate() {
        assert!(
            ours.as_ref() == theirs.as_bytes(),
            "/api/fleet answer {n} differs"
        );
    }
    for (n, ((body, seq), theirs)) in needs.iter().zip(&live.needs).enumerate() {
        assert!(
            body.as_slice() == theirs.body.as_bytes(),
            "/api/needs body {n} differs"
        );
        assert_eq!(*seq, &theirs.seq, "/api/needs x-boxbox-seq {n}");
    }
    println!(
        "{} /api/fleet and {} /api/needs answers match the replay",
        fleet.len(),
        needs.len()
    );
}

/// the clock of the tape's last step, for the queries asked after it.
fn end(steps: &[Step]) -> i64 {
    steps.last().map_or(0, |s| s.at)
}

#[test]
fn goldens_hello_and_reset_for_a_first_connection_at_the_end_of_the_session() {
    let live = live();
    let steps = tape();
    let at = end(&steps);
    let mut replay = replayed(&live, steps);
    let frames = replay.open(From::Start, at);
    assert_eq!(frames.len(), 2, "hello, then reset");
    golden(
        "hello-reset.sse.gz",
        &normalise(&joined(&frames), &live.epoch, &live.build),
    );
}

#[test]
fn goldens_cursor_resumes_inside_and_beyond_the_journal() {
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
    // inside: the last 20 entries replayed after hello, then live
    let inside = replay.open(cursor(head.saturating_sub(20)), at);
    assert_eq!(inside.len(), 21);
    golden(
        "resume-inside.sse",
        &normalise(&joined(&inside), &live.epoch, &live.build),
    );
    // at the head: hello alone, then live
    let at_head = replay.open(cursor(head), at);
    assert_eq!(at_head.len(), 1);
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

#[test]
fn goldens_a_resume_from_before_what_the_ring_holds_is_reset_as_expired() {
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
    assert!(replay.floor() > 1, "the small ring evicted");
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
fn goldens_the_fleet_and_the_needs_at_the_end_of_the_session() {
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
    golden("fleet.json.gz", std::str::from_utf8(fleet).unwrap());
    golden("needs.json", std::str::from_utf8(body).unwrap());
    golden(
        "needs.seq",
        &normalise(&format!("{seq}\n"), &live.epoch, &live.build),
    );
}

#[test]
fn goldens_push_payloads_and_titles_for_every_notice_of_the_session() {
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
fn the_recorded_session_costs_a_device_several_times_fewer_bytes_through_gzip() {
    let live = live();
    let steps = tape();
    let (start, finish) = (steps.first().unwrap().at, steps.last().unwrap().at);
    let mut replay = Replay::new(&live.epoch, &live.build);
    let mut gzip = crate::http::compress::Framed::new();
    let mut decoder = flate2::write::GzDecoder::new(Vec::new());
    let (mut head, mut plain, mut wire, mut writes) = (replay.head(), 0usize, 0usize, 0usize);
    for step in steps {
        replay.step(step).unwrap();
        let moved = usize::try_from(replay.head() - head).unwrap();
        head = replay.head();
        if moved == 0 {
            continue;
        }
        let journal = replay.journal();
        let batch: Vec<u8> = journal[journal.len() - moved..].concat();
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

/// a journal's frames with their seqs taken out, split into the session
/// entries (by key, in order) and every other frame (in order).
fn by_cadence(frames: &[Bytes]) -> (Vec<String>, std::collections::BTreeMap<String, Vec<String>>) {
    let (mut others, mut sessions) = (
        Vec::new(),
        std::collections::BTreeMap::<String, Vec<String>>::new(),
    );
    for frame in frames {
        let text = std::str::from_utf8(frame).unwrap();
        let data = text.lines().find_map(|l| l.strip_prefix("data: ")).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(data).unwrap();
        value.as_object_mut().unwrap().remove("seq");
        let line = value.to_string();
        match value["type"].as_str() {
            Some("session") => sessions
                .entry(value["session"]["key"].as_str().unwrap().to_owned())
                .or_default()
                .push(line),
            _ => others.push(line),
        }
    }
    (others, sessions)
}

/// today's tail pace against the pace the tape was recorded at: the same
/// frames in the same order but for session entries, which go out less
/// often, and each session's last entry the same.
#[test]
fn the_home_overview_pace_changes_only_how_often_a_session_entry_goes_out() {
    let live = live();
    let slow = replayed(&live, tape()).journal();
    let fast = recorded(&live, tape()).journal();
    let (slow_others, slow_sessions) = by_cadence(&slow);
    let (fast_others, fast_sessions) = by_cadence(&fast);
    assert!(
        slow_others == fast_others,
        "a frame other than a session entry moved"
    );
    assert_eq!(
        slow_sessions.keys().collect::<Vec<_>>(),
        fast_sessions.keys().collect::<Vec<_>>()
    );
    for (key, entries) in &slow_sessions {
        let recorded = &fast_sessions[key];
        assert_eq!(entries.last(), recorded.last(), "{key} ends elsewhere");
        assert!(entries.len() <= recorded.len(), "{key} went out more often");
    }
    let (slow_count, fast_count) = (
        slow_sessions.values().map(Vec::len).sum::<usize>(),
        fast_sessions.values().map(Vec::len).sum::<usize>(),
    );
    println!(
        "session entries: {fast_count} at {} ms, {slow_count} at {} ms; {} other frames alike; journal {} to {} bytes",
        super::RECORDED_TAIL_EVERY_MS,
        crate::fleet::model::TAIL_EVERY_MS,
        slow_others.len(),
        joined(&fast).len(),
        joined(&slow).len()
    );
    assert!(slow_count < fast_count);
}
