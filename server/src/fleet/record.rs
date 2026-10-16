//! the recorder: with the `record` feature and `BOXBOX_RECORD=<file>`, the
//! fleet actor writes every input it takes to that file as a tape
//! (`tape.rs`), each with the clock it took it at. a release never has
//! this; `bun bench/golden.ts record` builds a server with it to record the
//! replay fixture from a live cmx2 dev daemon.
//!
//! the actor hands each line to a writer thread over a bounded queue and
//! waits when the queue is full: a recording that drops a step is worthless,
//! and this build is a bench's, never a person's.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Mutex, OnceLock};

use serde_json::value::RawValue;
use tracing::{error, info, warn};

use super::tape::{self, Input, Step};
use super::{Command, From, Upstream};
use crate::journal::Cursor;
use crate::push::presence::Looking;

/// lines waiting for the writer.
const QUEUE: usize = 4096;
/// tail bodies read but not yet taken by the actor; a tail read reaches the
/// actor right after it is held, so more than this means something leaks.
const HELD_TAILS: usize = 1024;

static RECORDER: OnceLock<Option<SyncSender<String>>> = OnceLock::new();
/// the raw answers of tail reads on their way to the actor, by session key
/// and the cursor they came with: `TailRead` keeps only what decoded.
static TAIL_BODIES: Mutex<Vec<(String, String, Box<RawValue>)>> = Mutex::new(Vec::new());

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
    let (lines, queue) = sync_channel::<String>(QUEUE);
    let spawned = std::thread::Builder::new()
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
        });
    if let Err(error) = spawned {
        error!(%error, "the fleet recording's writer did not start; nothing is recorded");
        return None;
    }
    info!(path = %path.to_string_lossy(), "recording every fleet input");
    Some(lines)
}

fn write(at: i64, input: Input) {
    let Some(lines) = recorder() else { return };
    match serde_json::to_string(&Step { at, input }) {
        Ok(line) => {
            if lines.send(line).is_err() {
                warn!("the fleet recording's writer has stopped; a step was not recorded");
            }
        }
        Err(error) => error!(%error, "a fleet input did not serialize; the recording misses it"),
    }
}

/// `tails.rs` read this body for `key` at `cursor`; the actor takes it when
/// the decoded read arrives.
pub fn tail_body(key: &str, cursor: &Cursor, body: &[u8]) {
    if recorder().is_none() {
        return;
    }
    let Ok(text) = String::from_utf8(body.to_vec()) else {
        warn!(
            session = key,
            "a tail body is not utf-8; the recording misses it"
        );
        return;
    };
    let Ok(raw) = RawValue::from_string(text) else {
        warn!(
            session = key,
            "a tail body is not json; the recording misses it"
        );
        return;
    };
    if let Ok(mut held) = TAIL_BODIES.lock() {
        if held.len() >= HELD_TAILS {
            warn!(
                cap = HELD_TAILS,
                "tail bodies are not reaching the actor; the oldest is dropped"
            );
            held.remove(0);
        }
        held.push((key.to_owned(), cursor.to_string(), raw));
    }
}

fn take_tail_body(key: &str, cursor: &str) -> Option<Box<RawValue>> {
    let mut held = TAIL_BODIES.lock().ok()?;
    let at = held.iter().position(|(k, c, _)| k == key && c == cursor)?;
    Some(held.remove(at).2)
}

pub(super) fn upstream(at: i64, message: &Upstream) {
    if recorder().is_none() {
        return;
    }
    let input = match message {
        Upstream::Host(status) => Input::Host(Box::new(status.clone())),
        Upstream::HostRemoved(host) => Input::HostRemoved(host.clone()),
        Upstream::HostRead(read) => Input::HostRead(Box::new(tape::HostRead {
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
        })),
        Upstream::TailRead(read) => {
            let cursor = read.cursor.to_string();
            let Some(body) = take_tail_body(&read.key, &cursor) else {
                error!(
                    session = read.key,
                    cursor, "a tail read arrived without its body; the recording misses it"
                );
                return;
            };
            Input::TailRead {
                key: read.key.clone(),
                cursor,
                body,
            }
        }
        Upstream::TailUnread { key, reason } => Input::TailUnread {
            key: key.clone(),
            reason: reason.clone(),
        },
        Upstream::Event {
            host,
            seq,
            directory,
            payload,
            ..
        } => Input::Event {
            host: host.to_string(),
            seq: *seq,
            directory: directory.clone(),
            payload: payload.clone(),
        },
    };
    write(at, input);
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
        Command::Read {
            from,
            first,
            stream,
            ..
        } => tape::Command::Read {
            from: match from {
                From::Start => tape::From::Start,
                From::Malformed => tape::From::Malformed,
                From::At(cursor) => tape::From::At(cursor.to_string()),
            },
            first: *first,
            stream: *stream,
        },
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
        Command::Adopt { host, info, .. } => tape::Command::Adopt {
            host: host.clone(),
            info: info.clone(),
        },
        Command::AdoptedKeys { .. } => tape::Command::AdoptedKeys,
        Command::Places { host, .. } => tape::Command::Places { host: host.clone() },
        Command::Unadopt { key } => tape::Command::Unadopt { key: key.clone() },
        Command::ReviewTarget { key, .. } => tape::Command::ReviewTarget { key: key.clone() },
        Command::ReviewAnswered { key, device: d } => tape::Command::ReviewAnswered {
            key: key.clone(),
            device: device(d),
        },
        Command::ReviewGone { key } => tape::Command::ReviewGone { key: key.clone() },
    };
    write(at, Input::Command(command));
}
