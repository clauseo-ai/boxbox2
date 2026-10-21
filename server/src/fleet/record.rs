//! the recorder: with the `record` feature and `BOXBOX_RECORD=<file>`, the
//! fleet actor writes every input it takes to that file as a tape
//! (`tape.rs`), each with the clock it took it at. a release never has
//! this; `bun bench/golden.ts record` builds a server with it to record the
//! replay fixture from a live cmx2 dev daemon.
//!
//! the fleet actor no longer sees cmx2's wire: the cmx2 source translates
//! every frame before it is sent (docs/protocol.md 15). so the source holds
//! the raw input here, under this feature only, right before it sends the
//! translated event (`host`, `host_read`, `event`, `tail_body`; the adopt
//! routes `adopt_info`), and the actor takes it back when that event
//! arrives. the tape keeps the actor's order and clock, and a default build
//! carries nothing for it.
//!
//! the actor hands each line to a writer thread over a bounded queue and
//! waits when the queue is full: a recording that drops a step is worthless,
//! and this build is a bench's, never a person's.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;

use serde_json::value::RawValue;
use tracing::{error, info, warn};

use super::tape::{self, Input, Step};
use super::{Command, From, Upstream};
use crate::cmx2::Decoded;
use crate::journal::Cursor;
use crate::push::presence::Looking;
use crate::source::{SourceEvent, ThreadFacts};
use crate::upstream::HostStatus;
use crate::upstream::reconcile::HostRead;

/// lines waiting for the writer.
const QUEUE: usize = 4096;
/// raw inputs held but not yet taken by the actor. each reaches the actor
/// right after it is held (the fleet's queue is 1024 deep), so more than
/// this means something leaks.
const HELD: usize = 4096;

static RECORDER: OnceLock<Option<SyncSender<String>>> = OnceLock::new();
/// the raw inputs on their way to the actor, by connection.
static HELD_INPUTS: Mutex<Vec<(String, Held)>> = Mutex::new(Vec::new());

/// what a source held for the actor to record when the translated event
/// arrives.
#[derive(Debug)]
enum Held {
    /// the status `SourceEvent::Connection` was translated from.
    Host(Box<HostStatus>),
    /// the reads `SourceEvent::Snapshot` was translated from.
    Read(Box<tape::HostRead>),
    /// the frame an event was translated from.
    Event {
        seq: Option<u64>,
        directory: Option<String>,
        payload: Box<RawValue>,
    },
    /// the body of a tail read and the `x-cmx2-seq` it came with.
    Tail {
        thread: String,
        cursor: String,
        body: Box<RawValue>,
    },
    /// the session json an adopted thread was read from.
    Adopt { id: String, info: Box<RawValue> },
}

fn recorder() -> Option<&'static SyncSender<String>> {
    RECORDER.get_or_init(open).as_ref()
}

fn open() -> Option<SyncSender<String>> {
    let path = std::env::var_os("BOXBOX_RECORD")?;
    let file = match File::create(&path) {
        Ok(file) => file,
        Err(error) => {
            error!(%error, path = %path.to_string_lossy(), "the fleet recording could not be opened; nothing is recorded");
            return None;
        }
    };
    match writer(file) {
        Ok((lines, _)) => {
            info!(path = %path.to_string_lossy(), "recording every fleet input");
            Some(lines)
        }
        Err(error) => {
            error!(%error, "the fleet recording's writer did not start; nothing is recorded");
            None
        }
    }
}

/// the thread that writes each line it is sent to `file`, until every
/// sender is gone.
fn writer(file: File) -> std::io::Result<(SyncSender<String>, JoinHandle<()>)> {
    let (lines, queue) = sync_channel::<String>(QUEUE);
    let handle = std::thread::Builder::new()
        .name("fleet-record".into())
        .spawn(move || {
            let mut out = BufWriter::new(file);
            while let Ok(line) = queue.recv() {
                let written = out
                    .write_all(line.as_bytes())
                    .and_then(|()| out.write_all(b"\n"))
                    .and_then(|()| out.flush());
                if let Err(error) = written {
                    error!(%error, "the fleet recording could not be written; it stops here");
                    return;
                }
            }
        })?;
    Ok((lines, handle))
}

fn write(at: i64, input: Input) {
    if let Some(lines) = recorder() {
        send(lines, at, input);
    }
}

fn send(lines: &SyncSender<String>, at: i64, input: Input) {
    match serde_json::to_string(&Step { at, input }) {
        Ok(line) => {
            if lines.send(line).is_err() {
                warn!("the fleet recording's writer has stopped; a step was not recorded");
            }
        }
        Err(error) => error!(%error, "a fleet input did not serialize; the recording misses it"),
    }
}

fn raw(text: String, what: &str, connection: &str) -> Option<Box<RawValue>> {
    let raw = RawValue::from_string(text).ok();
    if raw.is_none() {
        warn!(
            connection,
            what, "a raw input is not json; the recording misses it"
        );
    }
    raw
}

fn hold(connection: &str, held: Held) {
    let Ok(mut inputs) = HELD_INPUTS.lock() else {
        return;
    };
    if inputs.len() >= HELD {
        warn!(
            cap = HELD,
            "raw inputs are not reaching the actor; the oldest is dropped"
        );
        inputs.remove(0);
    }
    inputs.push((connection.to_owned(), held));
}

fn take(connection: &str, matches: impl Fn(&Held) -> bool) -> Option<Held> {
    let mut inputs = HELD_INPUTS.lock().ok()?;
    let at = inputs
        .iter()
        .position(|(c, held)| c == connection && matches(held))?;
    Some(inputs.remove(at).1)
}

/// the watcher of `status.name` is about to send this status, translated.
pub fn host(status: &HostStatus) {
    if recorder().is_some() {
        hold(&status.name, Held::Host(Box::new(status.clone())));
    }
}

/// the watcher of `read.host` is about to send these reads, translated.
pub fn host_read(read: &HostRead) {
    if recorder().is_none() {
        return;
    }
    let read = tape::HostRead {
        host: read.host.clone(),
        epoch: read.epoch.clone(),
        sessions: tape::Stamped {
            seq: read.sessions.seq,
            data: read.sessions.data.clone(),
        },
        statuses: tape::Stamped {
            seq: read.statuses.seq,
            data: read.statuses.data.clone(),
        },
        permissions: tape::Stamped {
            seq: read.permissions.seq,
            data: read.permissions.data.clone(),
        },
        questions: tape::Stamped {
            seq: read.questions.seq,
            data: read.questions.data.clone(),
        },
    };
    hold(&read.host.clone(), Held::Read(Box::new(read)));
}

/// the watcher of `host` is about to send the event it translated from
/// this frame, with `seq`.
pub fn event(host: &str, seq: Option<u64>, frame: &Decoded) {
    if recorder().is_some() {
        hold(
            host,
            Held::Event {
                seq,
                directory: frame.directory.clone(),
                payload: frame.payload.clone(),
            },
        );
    }
}

/// `tails.rs` read this body for `session` of `host` at `cursor`; the
/// actor takes it when the decoded read arrives.
pub fn tail_body(host: &str, session: &str, cursor: &Cursor, body: &[u8]) {
    if recorder().is_none() {
        return;
    }
    let Ok(text) = String::from_utf8(body.to_vec()) else {
        warn!(
            host,
            session, "a tail body is not utf-8; the recording misses it"
        );
        return;
    };
    let Some(body) = raw(text, "a tail body", host) else {
        return;
    };
    hold(
        host,
        Held::Tail {
            thread: session.to_owned(),
            cursor: cursor.to_string(),
            body,
        },
    );
}

/// an adopt route read this session json from `host`; the actor takes it
/// when the adopt arrives. a read that does not adopt is dropped with the
/// oldest.
pub fn adopt_info(host: &str, info: &RawValue) {
    #[derive(serde::Deserialize)]
    struct Id {
        id: String,
    }
    if recorder().is_none() {
        return;
    }
    let Ok(Id { id }) = serde_json::from_str::<Id>(info.get()) else {
        return;
    };
    hold(
        host,
        Held::Adopt {
            id,
            info: info.to_owned(),
        },
    );
}

pub(super) fn upstream(at: i64, message: &Upstream) {
    if recorder().is_none() {
        return;
    }
    if let Some(input) = upstream_input(message) {
        write(at, input);
    }
}

/// the tape's input for what the actor took: the raw input its source held
/// for it. none for what the tape does not keep (another kind's events, a
/// frame cmx2 sent that did not decode).
fn upstream_input(message: &Upstream) -> Option<Input> {
    let (connection, seq, event) = match message {
        Upstream::HostRemoved(host) => return Some(Input::HostRemoved(host.clone())),
        Upstream::Source {
            connection,
            seq,
            event,
            ..
        } => (&**connection, *seq, event),
    };
    let missing = |what: &str| {
        error!(
            connection,
            what, "an input arrived without its raw input; the recording misses it"
        );
    };
    match event {
        SourceEvent::Connection(_) => {
            if let Some(Held::Host(status)) = take(connection, |h| matches!(h, Held::Host(_))) {
                return Some(Input::Host(status));
            }
            missing("a connection");
            None
        }
        SourceEvent::Snapshot(_) => {
            if let Some(Held::Read(read)) = take(connection, |h| matches!(h, Held::Read(_))) {
                return Some(Input::HostRead(read));
            }
            missing("a host read");
            None
        }
        SourceEvent::TailRead(read) => {
            let cursor = read.upstream.as_ref().map(|stamp| {
                Cursor {
                    epoch: stamp.epoch.clone(),
                    seq: stamp.seq,
                }
                .to_string()
            });
            let held = take(connection, |h| {
                matches!(h, Held::Tail { thread, cursor: c, .. }
                    if *thread == read.thread && Some(c) == cursor.as_ref())
            });
            if let Some(Held::Tail {
                thread,
                cursor,
                body,
            }) = held
            {
                return Some(Input::TailRead {
                    key: format!("{connection}:{thread}"),
                    cursor,
                    body,
                });
            }
            missing("a tail read");
            None
        }
        SourceEvent::TailUnread { thread, reason } => Some(Input::TailUnread {
            key: format!("{connection}:{thread}"),
            reason: reason.clone(),
        }),
        SourceEvent::Skipped
        | SourceEvent::Agents(_)
        | SourceEvent::Replaying
        | SourceEvent::CaughtUp => None,
        _ => {
            let held = take(
                connection,
                |h| matches!(h, Held::Event { seq: s, .. } if *s == seq),
            );
            if let Some(Held::Event {
                seq,
                directory,
                payload,
            }) = held
            {
                return Some(Input::Event {
                    host: connection.to_owned(),
                    seq,
                    directory,
                    payload,
                });
            }
            None
        }
    }
}

fn adopted(host: &str, thread: &ThreadFacts) -> Option<Box<RawValue>> {
    if let Some(Held::Adopt { info, .. }) = take(
        host,
        |h| matches!(h, Held::Adopt { id, .. } if *id == thread.id),
    ) {
        return Some(info);
    }
    error!(
        host,
        thread = thread.id,
        "an adopt arrived without its session json; the recording misses it"
    );
    None
}

pub(super) fn flush_tails(at: i64) {
    write(at, Input::FlushTails);
}

pub(super) fn looking(at: i64, devices: &[Looking]) {
    if recorder().is_none() {
        return;
    }
    let devices = devices
        .iter()
        .map(|d| tape::Looking {
            device: d.device.clone(),
            class: d.class.clone(),
            thread: d.thread.clone(),
            until: d.until,
        })
        .collect();
    write(at, Input::Looking(devices));
}

fn device(device: &super::Device) -> tape::Device {
    tape::Device {
        id: device.id.clone(),
        class: device.class.clone(),
    }
}

pub(super) fn command(at: i64, command: &Command) {
    if recorder().is_none() {
        return;
    }
    let command = match command {
        // a stream opens in one step: the tape's first page of it
        Command::Open { opening, .. } => tape::Command::Read {
            from: match &opening.from {
                From::Start => tape::From::Start,
                From::Malformed => tape::From::Malformed,
                From::At(cursor) => tape::From::At(cursor.to_string()),
            },
            first: true,
            stream: opening.log,
        },
        // what a stream shows and when it ends change what reaches it, never the fleet
        Command::Interest { .. }
        | Command::Stalled { .. }
        | Command::Ended { .. }
        | Command::Versions { .. } => return,
        Command::Snapshot { .. } => tape::Command::Snapshot,
        Command::Needs { .. } => tape::Command::Needs,
        Command::Arm {
            key,
            client_id,
            device: d,
        } => tape::Command::Arm {
            key: key.clone(),
            client_id: client_id.clone(),
            device: device(d),
        },
        Command::Answering {
            host,
            ask,
            device: d,
        } => tape::Command::Answering {
            host: host.clone(),
            ask: ask.clone(),
            device: device(d),
        },
        Command::OwnAction { key } => tape::Command::OwnAction { key: key.clone() },
        Command::MarkRead {
            key,
            device: d,
            message,
            at,
            ..
        } => tape::Command::MarkRead {
            key: key.clone(),
            device: device(d),
            message: message.clone(),
            at: *at,
        },
        Command::Clear {
            keys, device: d, ..
        } => tape::Command::Clear {
            keys: keys.clone(),
            device: device(d),
        },
        Command::ClearedAmong { rows, .. } => tape::Command::ClearedAmong { rows: rows.clone() },
        Command::Adopt { host, thread, .. } => {
            let Some(info) = adopted(host, thread) else {
                return;
            };
            tape::Command::Adopt {
                host: host.clone(),
                info,
            }
        }
        Command::AdoptedKeys { .. } => tape::Command::AdoptedKeys,
        Command::Places { host, .. } => tape::Command::Places { host: host.clone() },
        Command::Unadopt { key } => tape::Command::Unadopt { key: key.clone() },
        Command::ReviewTarget { key, .. } => tape::Command::ReviewTarget { key: key.clone() },
        Command::ReviewAnswered { key, device: d } => tape::Command::ReviewAnswered {
            key: key.clone(),
            device: device(d),
        },
        Command::ReviewGone { key } => tape::Command::ReviewGone { key: key.clone() },
        // the tape has no colours and no board (the bench drives neither):
        // a recording that took one does not replay to its journal
        Command::ChooseColour { .. } | Command::Board(_) => {
            warn!("a colour choice or a board command is not on the tape; the recording misses it");
            return;
        }
    };
    write(at, Input::Command(command));
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::upstream::{Connection, FrameCounts};

    fn source(connection: &str, seq: Option<u64>, event: SourceEvent) -> Upstream {
        let name: Arc<str> = Arc::from(connection);
        Upstream::Source {
            connection: Arc::clone(&name),
            agent: name,
            seq,
            event,
        }
    }

    #[test]
    fn what_a_source_held_is_recorded_as_tape_steps_in_the_actors_order() {
        // a connection no other test holds for
        let host = "p3-rec-test";
        let status = HostStatus {
            name: host.into(),
            url: "http://127.0.0.1:4840/".into(),
            origin: crate::config::Origin::Config,
            memory: None,
            system: None,
            reports_system: None,
            connection: Connection::Connected,
            since: 0,
            health: None,
            last_error: None,
            connects: 1,
            frames: FrameCounts::default(),
            cursor: None,
        };
        hold(host, Held::Host(Box::new(status.clone())));
        let payload = RawValue::from_string(
            r#"{"type":"session.deleted","properties":{"sessionID":"ses_1"}}"#.into(),
        )
        .unwrap();
        hold(
            host,
            Held::Event {
                seq: Some(7),
                directory: Some("/tmp/repo".into()),
                payload,
            },
        );
        let messages = [
            source(
                host,
                None,
                SourceEvent::Connection(crate::source::cmx2::translate::connection(status)),
            ),
            source(
                host,
                Some(7),
                SourceEvent::ThreadRemoved {
                    thread: "ses_1".into(),
                },
            ),
            source(
                host,
                None,
                SourceEvent::TailUnread {
                    thread: "ses_2".into(),
                    reason: "busy".into(),
                },
            ),
            source(host, Some(8), SourceEvent::Skipped),
            Upstream::HostRemoved(host.into()),
        ];

        let path = std::path::Path::new("/tmp")
            .join(format!("p3_server-h2-rec-{}.jsonl", std::process::id()));
        let (lines, handle) = writer(File::create(&path).unwrap()).unwrap();
        for (at, message) in (10..).zip(&messages) {
            if let Some(input) = upstream_input(message) {
                send(&lines, at, input);
            }
        }
        drop(lines);
        handle.join().unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();

        let steps: Vec<Step> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            steps.len(),
            4,
            "the skipped frame is not on the tape: {text}"
        );
        assert_eq!(
            steps.iter().map(|s| s.at).collect::<Vec<_>>(),
            [10, 11, 12, 14]
        );
        assert!(matches!(&steps[0].input, Input::Host(s) if s.name == host && s.connects == 1));
        assert!(matches!(
            &steps[1].input,
            Input::Event { host: h, seq: Some(7), directory: Some(d), payload }
                if h == host && d == "/tmp/repo" && payload.get().contains("session.deleted")
        ));
        assert!(matches!(
            &steps[2].input,
            Input::TailUnread { key, reason } if key == "p3-rec-test:ses_2" && reason == "busy"
        ));
        assert!(matches!(&steps[3].input, Input::HostRemoved(h) if h == host));
        assert!(take(host, |_| true).is_none(), "everything held was taken");
    }
}
