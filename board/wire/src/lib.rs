//! the board channel (`docs/board.md`): the shapes the boxbox server and the
//! board daemon exchange, and the frames the server hands app windows on the
//! mac the board is plugged into.
//!
//! one crate so the two ends cannot drift: the server compiles it with the
//! `openapi` feature (the web app's decoders are generated from that
//! document), the daemon without. json is camelCase, like contract 2.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// bumped only for a change an older daemon would misread. the server answers
/// a stream asking for another protocol with 409, and the daemon says so in
/// its log instead of drawing a wrong board.
pub const PROTOCOL: u32 = 1;

/// at most this many threads ride a view: four pages of nine keys. the board
/// cannot show more without paging past what anyone reads on a keypad, and
/// the cap keeps a view a few kilobytes however big the fleet is.
pub const MAX_THREADS: usize = 36;

/// at most this many machine lights: `/ * - +` (decision 78).
pub const MAX_MACHINES: usize = 4;

/// `GET /api/board/stream?protocol=1&device=board-…&addrs=…`, an sse stream
/// of [`Frame`]s. `addrs` is every address of the mac the daemon runs on
/// (tailnet v4 and v6, lan), comma separated: the server matches app windows
/// against them to find the windows on the board's mac, since a browser
/// cannot say which machine it is on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::IntoParams))]
#[serde(rename_all = "camelCase")]
pub struct StreamQuery {
    pub protocol: u32,
    /// the daemon's device id, `[A-Za-z0-9_-]{1,64}`, kept in its state dir.
    pub device: String,
    #[serde(default)]
    pub addrs: String,
}

/// one sse `data:` line on the board stream.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Frame {
    /// first on every stream.
    Hello { protocol: u32, version: String },
    /// the whole board, after `hello` and whenever anything on it changes,
    /// coalesced. a view replaces the last one; there are no patches and no
    /// cursor, so a reconnect is just the next view.
    View(View),
    /// the app armed a pairing: the next digit key pressed binds this thread.
    Pin {
        key: String,
        color: [u8; 3],
        #[serde(rename = "expiresInMs")]
        expires_in_ms: u32,
    },
    /// another board stream took over; this one closes after the frame.
    Replaced,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// in board order (`[board] machines` in boxbox.toml, else the app's
    /// machine order), at most [`MAX_MACHINES`].
    pub machines: Vec<Machine>,
    /// the home windows that need you or are working, plus every bound
    /// thread, in the app's window order (the order `⌥1` to `⌥9` open). the
    /// app ranks needs and working threads ahead of quiet ones, so digit n on
    /// an unpaired board is window n in the app. at most [`MAX_THREADS`].
    pub threads: Vec<Thread>,
    pub bindings: Vec<Binding>,
}

/// a machine light: every agent whose `label.machine` is this name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub name: String,
    /// any of its agents connected.
    pub up: bool,
    /// how hard it is streaming, 0 to 5: the fleet bank's column height.
    pub activity: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// `<agent>:<thread>`, the key every route takes.
    pub key: String,
    /// what readback says; never shown on the board.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub need: Option<Need>,
    /// how long the need has waited, as of this frame. an age rather than a
    /// time, so the vm's clock and the mac's never have to agree; the daemon
    /// adds its own elapsed time for readback minutes and the hot threshold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_ms: Option<u64>,
    /// a turn is running.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub working: bool,
    /// it streamed text in the last two seconds: a working key lights bright
    /// instead of at rest. the server flips it, so token deltas never reach
    /// the board.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fresh: bool,
    /// prompts queued behind the running turn.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub queued: u32,
    /// the open ask the pit answers, when the need is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<Ask>,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub enum Need {
    Permission,
    Question,
    Fault,
    Review,
    /// a finished turn nobody has seen, or a job's news (`done`, `job`).
    News,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub id: String,
    pub kind: AskKind,
    /// a single question's option labels, at most nine (one per digit). empty
    /// for a permission, and for an ask the keys cannot answer (several
    /// questions, or free text), which is answered by voice or on the glass.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub enum AskKind {
    Permission,
    Question,
}

/// a digit key paired with a thread: it keeps that key and its livery.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// a digit key's wire index; the server refuses any other key.
    pub wire: u8,
    pub key: String,
    pub color: [u8; 3],
}

/// `POST /api/board/act`, everything the daemon does to the fleet. 204 when
/// the server (and, for a reply or a flush, the agent) took it; the daemon's
/// telemetry `ok` is that answer, never the local call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(tag = "verb", rename_all = "camelCase")]
pub enum Act {
    /// open the thread on the board's mac, as a tap would, with the caret in
    /// its composer: a key press aims you at a thread to talk to it, and the
    /// dictation the keypad starts types into whatever holds focus.
    Focus {
        key: String,
    },
    /// open the new-thread sheet on the board's mac with this machine picked.
    Compose {
        machine: String,
    },
    /// mark the thread read up to its newest message.
    Read {
        key: String,
    },
    Reply {
        key: String,
        ask: String,
        answer: Answer,
    },
    /// stop the running turn and run the queue now.
    Flush {
        key: String,
    },
    /// the digits the board shows now, for the badges on the board's mac.
    /// sent when they change, never on a clock.
    Seats {
        seats: Vec<Seat>,
    },
    Bind(Binding),
    Unbind {
        wire: u8,
    },
    /// the board was unplugged: its windows drop their digits now rather
    /// than when the stream times out.
    Gone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Answer {
    Once,
    Always,
    Reject,
    /// a question's option, by its index in [`Ask::options`].
    Option {
        index: u8,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    pub key: String,
    /// 1 to 9.
    pub digit: u8,
    /// the digit is a paired key holding this thread (a [`Binding`]), not a
    /// seat by order. the app needs it to tell a press that paired a thread
    /// from the digit it already sat on, and draws a kept key as kept.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bound: bool,
}

/// `POST /api/board/pin` from the app: arm the board so the next digit key
/// pressed pairs with this thread.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct PinRequest {
    pub key: String,
    pub color: [u8; 3],
}

/// what app windows on the board's mac receive on `/api/stream?board=1`:
/// id-less frames outside the journal (they carry no seq and move no
/// cursor), sent only to a stream that asked for them and whose address is
/// the board's mac. a stream that never asks (ios, a phone) never sees one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(tag = "type")]
pub enum AppFrame {
    /// the board is on this mac and shows these digits. sent when a board
    /// arrives, when a window's stream opens while one is here, and whenever
    /// the digits change.
    #[serde(rename = "board.here")]
    Here { seats: Vec<Seat> },
    /// the board left this mac (unplugged, moved, or its stream timed out).
    #[serde(rename = "board.gone")]
    Gone,
    #[serde(rename = "board.focus")]
    Focus { key: String },
    #[serde(rename = "board.compose")]
    Compose { machine: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_read_as_the_doc_says() -> Result<(), serde_json::Error> {
        let pin: Frame = serde_json::from_str(
            r#"{"type":"pin","key":"desk:s1","color":[1,2,3],"expiresInMs":30000}"#,
        )?;
        assert_eq!(
            pin,
            Frame::Pin {
                key: "desk:s1".into(),
                color: [1, 2, 3],
                expires_in_ms: 30_000
            }
        );
        let act = serde_json::to_string(&Act::Reply {
            key: "desk:s1".into(),
            ask: "a1".into(),
            answer: Answer::Option { index: 2 },
        })?;
        assert_eq!(
            act,
            r#"{"verb":"reply","key":"desk:s1","ask":"a1","answer":{"kind":"option","index":2}}"#
        );
        let here = serde_json::to_string(&AppFrame::Here {
            seats: vec![Seat {
                key: "desk:s1".into(),
                digit: 1,
                bound: false,
            }],
        })?;
        assert_eq!(
            here,
            r#"{"type":"board.here","seats":[{"key":"desk:s1","digit":1}]}"#
        );
        Ok(())
    }

    #[test]
    fn a_quiet_thread_is_its_key_alone() -> Result<(), serde_json::Error> {
        let quiet = Thread {
            key: "desk:s1".into(),
            title: None,
            need: None,
            waiting_ms: None,
            working: false,
            fresh: false,
            queued: 0,
            ask: None,
        };
        assert_eq!(serde_json::to_string(&quiet)?, r#"{"key":"desk:s1"}"#);
        Ok(())
    }
}
