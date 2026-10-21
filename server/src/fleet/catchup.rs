//! a thread's missed transcript, compacted (`docs/protocol.md`, section 9),
//! and the `catchup` frames that carry it.
//!
//! from the thread's journal entries after a client's `since`, in order:
//!
//! - per message, only its last `message`;
//! - per part, its newest `part` that carries text, then the deltas after
//!   it merged, then its last `part` if that one is newer (a settled part
//!   with `textOf`, which the merged text before it satisfies), then the
//!   deltas after that merged; a part with no text-carrying `part` keeps
//!   its deltas merged ahead of its last `part`;
//! - `message.removed` drops every earlier entry of its message;
//! - `reactions`, the last per message.
//!
//! deltas merge only while they chain (`offset` equal to the run's offset
//! plus its utf-16 length), so applying a merged run is exactly applying
//! its deltas in turn. each kept entry keeps its own seq and upstream (a
//! merged run the seq of its last delta), and they go out in seq order: the
//! client's upstream gate drops an entry at or below the last one it
//! applied, so any other order would lose entries. a message whose last
//! `message` comes after one of its parts also keeps its first `message`
//! after `since`, so it exists before its parts (else the client would read
//! the message again).

use std::collections::HashMap;

use bytes::Bytes;

use crate::journal::sse_frame;
use crate::wire::{Change, JournalEntry, Part};

/// raw bytes of one `catchup` frame, at most.
pub const FRAME_BYTES: usize = 256 * 1024;
/// raw bytes of the `catchup` frames one catch-up or confirm carries, at most.
pub const BLOCK_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Group {
    Message(String),
    Reactions(String),
    Part(String),
    Removed(String),
}

#[derive(Debug)]
struct Slot {
    group: Group,
    /// the message the slot belongs to.
    message: String,
    entries: Vec<JournalEntry>,
}

/// a thread's entries after `since`, oldest first, compacted.
#[must_use]
pub fn compact(entries: Vec<JournalEntry>) -> Vec<JournalEntry> {
    let mut slots: Vec<Option<Slot>> = Vec::new();
    let mut open: HashMap<Group, usize> = HashMap::new();
    for entry in entries {
        let (group, message) = match &entry.change {
            Change::Message { message, .. } => {
                (Group::Message(message.id.clone()), message.id.clone())
            }
            Change::Reactions { message_id, .. } => {
                (Group::Reactions(message_id.clone()), message_id.clone())
            }
            Change::Part { part, .. } => (
                Group::Part(part.id().to_owned()),
                part.message_id().to_owned(),
            ),
            Change::Delta {
                message_id,
                part_id,
                ..
            } => (Group::Part(part_id.clone()), message_id.clone()),
            Change::MessageRemoved { message_id, .. } => {
                // every earlier entry of the message goes, an earlier removal too
                for slot in &mut slots {
                    if let Some(s) = slot.take_if(|s| s.message == *message_id) {
                        open.remove(&s.group);
                    }
                }
                (Group::Removed(message_id.clone()), message_id.clone())
            }
            // a catch-up carries transcript entries only
            _ => continue,
        };
        if let Some(slot) = open.get(&group).and_then(|&at| slots[at].as_mut()) {
            match group {
                Group::Part(_) => slot.entries.push(entry),
                // a message keeps its first entry beside its last, for below
                Group::Message(_) => {
                    slot.entries.truncate(1);
                    slot.entries.push(entry);
                }
                _ => slot.entries = vec![entry],
            }
        } else {
            open.insert(group.clone(), slots.len());
            slots.push(Some(Slot {
                group,
                message,
                entries: vec![entry],
            }));
        }
    }
    let mut out = Vec::new();
    let mut firsts = Vec::new();
    for slot in slots.into_iter().flatten() {
        match slot.group {
            Group::Part(_) => out.extend(part(slot.entries)),
            Group::Message(_) => {
                let mut entries = slot.entries;
                if entries.len() > 1 {
                    firsts.push(entries.remove(0));
                }
                out.extend(entries);
            }
            _ => out.extend(slot.entries),
        }
    }
    // a message whose last entry comes after one of its parts keeps its first
    // too, so it exists before them
    for first in firsts {
        let id = message_of(&first);
        let last = out
            .iter()
            .find(|e| matches!(&e.change, Change::Message { message, .. } if message.id == id))
            .map_or(0, |e| e.seq);
        if out.iter().any(|e| {
            e.seq < last && !matches!(e.change, Change::Message { .. }) && message_of(e) == id
        }) {
            out.push(first);
        }
    }
    // the client's upstream gate drops an entry at or below the last it applied
    out.sort_by_key(|e| e.seq);
    out
}

/// the message an entry belongs to.
fn message_of(entry: &JournalEntry) -> &str {
    match &entry.change {
        Change::Message { message, .. } => &message.id,
        Change::Part { part, .. } => part.message_id(),
        Change::Delta { message_id, .. }
        | Change::Reactions { message_id, .. }
        | Change::MessageRemoved { message_id, .. } => message_id,
        _ => "",
    }
}

fn carries_text(part: &Part) -> bool {
    match part {
        Part::Text(p) => p.text.is_some(),
        Part::Reasoning(p) => p.text.is_some(),
        _ => false,
    }
}

fn settled(part: &Part) -> bool {
    match part {
        Part::Text(p) => p.text.is_none() && p.text_of.is_some(),
        Part::Reasoning(p) => p.text.is_none() && p.text_of.is_some(),
        _ => false,
    }
}

fn as_part(entry: &JournalEntry) -> Option<&Part> {
    match &entry.change {
        Change::Part { part, .. } => Some(part),
        _ => None,
    }
}

/// one part's entries, compacted.
fn part(entries: Vec<JournalEntry>) -> Vec<JournalEntry> {
    let last = entries.iter().rposition(|e| as_part(e).is_some());
    let Some(last) = last else {
        return merged(entries);
    };
    let text = entries
        .iter()
        .rposition(|e| as_part(e).is_some_and(carries_text));
    let mut out = Vec::new();
    let end = entries.len();
    let mut entries: Vec<Option<JournalEntry>> = entries.into_iter().map(Some).collect();
    let deltas = |entries: &mut [Option<JournalEntry>], from: usize, to: usize| {
        let run: Vec<JournalEntry> = entries[from..to]
            .iter_mut()
            .filter_map(|e| e.take_if(|e| matches!(e.change, Change::Delta { .. })))
            .collect();
        merged(run)
    };
    let settles = entries[last]
        .as_ref()
        .and_then(as_part)
        .is_some_and(settled);
    match text {
        Some(text) if text != last && settles => {
            out.extend(entries[text].take());
            out.extend(deltas(&mut entries, text + 1, last));
            out.extend(entries[last].take());
            out.extend(deltas(&mut entries, last + 1, end));
        }
        None if settles => {
            out.extend(deltas(&mut entries, 0, last));
            out.extend(entries[last].take());
            out.extend(deltas(&mut entries, last + 1, end));
        }
        // the last part replaces what came before it
        _ => {
            out.extend(entries[last].take());
            out.extend(deltas(&mut entries, last + 1, end));
        }
    }
    out
}

fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

/// deltas merged while they chain; anything else is kept as it is.
fn merged(entries: Vec<JournalEntry>) -> Vec<JournalEntry> {
    let mut out: Vec<JournalEntry> = Vec::new();
    for entry in entries {
        if let (
            Some(JournalEntry {
                seq,
                change:
                    Change::Delta {
                        part_id: run_part,
                        field: run_field,
                        delta: run_text,
                        offset: run_offset,
                        ..
                    },
            }),
            Change::Delta {
                part_id,
                field,
                delta,
                offset,
                ..
            },
        ) = (out.last_mut(), &entry.change)
            && run_part == part_id
            && run_field == field
            && *offset == *run_offset + utf16_len(run_text)
        {
            run_text.push_str(delta);
            *seq = entry.seq;
            continue;
        }
        out.push(entry);
    }
    out
}

/// entries as `catchup` frames of at most `FRAME_BYTES` raw each, or none
/// when one entry alone is bigger than a frame. the frames are id-less.
#[must_use]
pub fn frames(entries: &[JournalEntry]) -> Option<Vec<Bytes>> {
    let mut frames = Vec::new();
    let mut json: Vec<u8> = Vec::new();
    for entry in entries {
        let one = serde_json::to_vec(entry).ok()?;
        if HEAD.len() + one.len() + LINES > FRAME_BYTES {
            return None;
        }
        if !json.is_empty() && json.len() + 1 + one.len() + LINES > FRAME_BYTES {
            frames.push(close(&mut json));
        }
        if json.is_empty() {
            json.extend_from_slice(HEAD);
        } else {
            json.push(b',');
        }
        json.extend_from_slice(&one);
    }
    if !json.is_empty() {
        frames.push(close(&mut json));
    }
    Some(frames)
}

const HEAD: &[u8] = b"{\"type\":\"catchup\",\"entries\":[";
const TAIL: &[u8] = b"]}";
/// a frame's bytes beside its entries: `data: `, the json's close, the
/// newline and the blank line.
const LINES: usize = 6 + TAIL.len() + 2;

fn close(json: &mut Vec<u8>) -> Bytes {
    json.extend_from_slice(TAIL);
    let frame = sse_frame(None, json);
    json.clear();
    frame
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{Control, Message, PartAt, TextOf, TextPart};

    fn at(seq: u64, change: Change) -> JournalEntry {
        JournalEntry { seq, change }
    }

    fn message(id: &str) -> Change {
        let message: Message = serde_json::from_value(
            serde_json::json!({"id": id, "role": "assistant", "created": 1.0}),
        )
        .unwrap();
        Change::Message {
            key: "k".into(),
            upstream: None,
            message,
        }
    }

    fn text(id: &str, text: Option<&str>, of: Option<TextOf>) -> Change {
        Change::Part {
            key: "k".into(),
            upstream: None,
            part: Part::Text(TextPart {
                id: id.into(),
                message_id: "m".into(),
                at: Some(PartAt { step: 1, index: 0 }),
                text: text.map(Into::into),
                text_of: of,
                streaming: false,
                time: None,
                synthetic: false,
                notice: false,
                mail: None,
            }),
        }
    }

    fn delta(part: &str, text: &str, offset: u64) -> Change {
        Change::Delta {
            key: "k".into(),
            message_id: "m".into(),
            part_id: part.into(),
            field: "text".into(),
            delta: text.into(),
            offset,
        }
    }

    fn shape(entries: &[JournalEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|e| match &e.change {
                Change::Delta { delta, offset, .. } => format!("{}:delta {offset} {delta}", e.seq),
                other => format!("{}:{}", e.seq, other.kind()),
            })
            .collect()
    }

    #[test]
    fn a_streamed_part_keeps_its_start_its_words_merged_and_its_settled_end() {
        let of = TextOf {
            length: 11,
            hash: "x".into(),
        };
        let entries = vec![
            at(1, message("m")),
            at(2, text("p", Some(""), None)),
            at(3, delta("p", "hello ", 0)),
            at(4, delta("p", "world", 6)),
            at(5, message("m")),
            at(6, text("p", None, Some(of))),
        ];
        assert_eq!(
            shape(&compact(entries)),
            [
                "1:message",
                "2:part",
                "4:delta 0 hello world",
                "5:message",
                "6:part"
            ]
        );
    }

    #[test]
    fn deltas_that_do_not_chain_stay_apart_and_a_whole_part_replaces_what_came_before() {
        let entries = vec![
            at(1, delta("p", "ab", 0)),
            at(2, delta("p", "zz", 9)),
            at(3, delta("q", "x", 0)),
            at(4, text("q", Some("xy"), None)),
            at(5, delta("q", "z", 2)),
        ];
        assert_eq!(
            shape(&compact(entries)),
            ["1:delta 0 ab", "2:delta 9 zz", "4:part", "5:delta 2 z"]
        );
    }

    #[test]
    fn a_removal_drops_what_came_before_it_of_its_message() {
        let entries = vec![
            at(1, message("m")),
            at(2, delta("p", "ab", 0)),
            at(
                3,
                Change::MessageRemoved {
                    key: "k".into(),
                    upstream: None,
                    message_id: "m".into(),
                },
            ),
            at(4, message("n")),
        ];
        assert_eq!(shape(&compact(entries)), ["3:message.removed", "4:message"]);
    }

    #[test]
    fn frames_stay_under_their_cap_and_parse_back_whole() {
        let entries: Vec<JournalEntry> = (0..400u64)
            .map(|n| at(n + 1, delta(&format!("p{n}"), &"w".repeat(2000), 0)))
            .collect();
        let frames = frames(&entries).unwrap();
        assert!(frames.len() > 1);
        let mut back = Vec::new();
        for frame in &frames {
            assert!(frame.len() <= FRAME_BYTES);
            let data = crate::journal::frame_data(frame);
            let Control::Catchup { entries } = serde_json::from_slice(&data).unwrap() else {
                panic!()
            };
            back.extend(entries);
        }
        assert_eq!(back, entries);
        let huge = [at(1, delta("p", &"w".repeat(FRAME_BYTES), 0))];
        assert!(super::frames(&huge).is_none());
    }
}
