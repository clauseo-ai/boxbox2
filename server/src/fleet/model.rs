//! the fleet model: every host's sessions, their statuses, the asks that
//! wait on a person, each session's window tail, and the window order.
//! computed once here and rendered by every surface (decision 16).
//!
//! pure: it takes decoded daemon events and fresh host reads, and returns
//! what changed as protocol 3's whole changes (`wire::Change`: an agent, a
//! thread, an ask, the order, a transcript entry), which the actor's encoder
//! turns into the patches the journal carries. no io, no clocks, so the
//! tests below are the whole story of how the fleet moves.
//!
//! after a host is read afresh, each read's seq is a floor for its domain
//! (sessions, statuses, permissions, questions): an event at or below it is
//! already in the read, and applying it again could turn the model back in
//! time (a busy status from before an idle read). transcript events are
//! never filtered here; a client filters them against its own transcript
//! read.
//!
//! needs and read state are derived here too (`needs.rs`, `read.rs`), from
//! the same events, once. the model keeps no clock: the actor tells it the
//! time (`at`) before each input, and collects what the outside world must
//! hear (`drain`): needs to persist and count, notices for push, read
//! marks for the store.
//!
//! streamed text grows a window's tail as it arrives, but a thread goes out
//! at most once per `TAIL_EVERY_MS` for it: the first delta after a quiet
//! spell goes out with its delta, later ones are held and the actor's clock
//! flushes them (`tail_due`, `flush_tails`). any other change to the
//! thread carries the held text out with it.
//!
//! a window's tail is read from the daemon once (`ReadTail`, carried out by
//! `upstream/tails.rs`) when the fleet learns of a session that gets a
//! window, so a session idle since before boxbox started still shows what
//! it last did. the read reflects upstream seq R (`x-cmx2-seq`): the tail
//! changes that came while it was out are kept as small ops and replayed on
//! top of it when newer than R, and afterwards a sequenced transcript event
//! at or below R leaves the tail alone. deltas carry no seq; their offset
//! decides, as it always does.

pub mod board;
pub mod state;

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tracing::{info, warn};

use super::clears::{Cause, Clear, Clears, Kept};
use super::colours::{self, Colours};
use super::needs::{By, How, Moved, Need, NeedKind, Needs, last_sentences};
use super::read::{Mark, Reads};
use crate::prefs::{AutoClear, HomePrefs};
use crate::push::presence::Looking;
use crate::push::{About, AskKind as PushAsk, Notice, Origin, Thread};
use crate::source::{
    ConnectionStatus, Notice as SourceNotice, Snapshot, SourceEvent, TailRead, ThreadFacts,
};
use crate::wire::{self, Change, Part, SettlerKind, TailKind, TailRole};

/// sessions held across every host; past it the least recently updated
/// idle session with no ask is dropped (every map has an eviction rule).
pub const MAX_SESSIONS: usize = 1000;
/// the window order lists at most this many sessions (architecture: 300
/// sessions with windows).
pub const MAX_ORDER: usize = 300;
/// `seen1h`: how long after a person's read mark covered a thread's newest
/// finished reply the sweep clears it (decision 93).
pub const SEEN_FOR_MS: i64 = 60 * 60 * 1000;
/// `any3h`: how long after a thread settled the sweep clears it, seen or not.
pub const SETTLED_FOR_MS: i64 = 3 * 60 * 60 * 1000;
/// threads one sweep clears at most; the rest wait for the next run. each
/// clear queues two or three writes, and the fleet's write queue holds 1024.
pub const MAX_SWEEP_CLEARS: usize = 100;

/// how often the auto-clear sweep runs and how long its rules wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SweepPace {
    /// after a start, before the first sweep: the hosts have been read by then.
    pub first: std::time::Duration,
    pub every: std::time::Duration,
    /// `seen1h`'s wait, ms.
    pub seen_for: i64,
    /// `any3h`'s wait, ms.
    pub settled_for: i64,
}

impl Default for SweepPace {
    fn default() -> Self {
        Self {
            first: std::time::Duration::from_secs(60),
            every: std::time::Duration::from_secs(5 * 60),
            seen_for: SEEN_FOR_MS,
            settled_for: SETTLED_FOR_MS,
        }
    }
}

impl SweepPace {
    /// `[dev] sweep_fast`: a sweep every 10 s, `seen1h` after a minute and
    /// `any3h` after three, so a dev server shows auto-clear while you watch.
    #[must_use]
    pub fn fast() -> Self {
        Self {
            first: std::time::Duration::from_secs(10),
            every: std::time::Duration::from_secs(10),
            seen_for: 60 * 1000,
            settled_for: 3 * 60 * 1000,
        }
    }
}
/// threads opened from history that the fleet holds beyond its host's newest
/// 300 (`Model::adopt`). the oldest idle one goes when another comes in; a
/// thread on a device's stage never does.
pub const MAX_ADOPTED: usize = 20;
/// parts a window tail keeps.
pub const TAIL_ITEMS: usize = 12;
/// characters of text a tail item keeps: the end of what the agent says,
/// the start of what you asked.
pub const TAIL_TEXT: usize = 280;
/// a thread goes into the journal at most this often while only streamed
/// text moves its tail: the home overview's pace (`docs/protocol.md`,
/// section 6). 500 ms (it was 200) moves a window's text a few words at a
/// time.
pub const TAIL_EVERY_MS: i64 = 500;
/// a session touched this recently has a window (`design.md`, the model:
/// windows; `app/src/ui/home/membership.ts`), ms.
pub const WINDOW_RECENT_MS: f64 = 12.0 * 60.0 * 60.0 * 1000.0;
/// tail changes kept while a session's read is out. contiguous deltas of a
/// part are one op and a part's later versions replace its op, so this is
/// two dozen distinct changes in the time one read takes; past it the read
/// is dropped and taken again.
const TAIL_OPS: usize = 24;
/// reads of one session's tail dropped for that reason, at most, before
/// the live tail is kept as it is.
const TAIL_READ_ATTEMPTS: u8 = 3;
/// messages a session remembers the role of, so a part lands on the side
/// of whoever wrote it. a part arrives right behind its message.
const SAID: usize = 16;
/// a send's arming waits this long for its message to land.
const ARM_FOR_MS: i64 = 10 * 60 * 1000;
/// sends armed and not yet landed, at most.
const MAX_ARMS: usize = 256;
/// a turn that starts this soon after a device's send armed it is that send's: cmx2 turns a session busy
/// before the prompt's message lands, so the arm is still waiting for it when the status arrives.
const SEND_STARTS_WITHIN_MS: i64 = 10_000;
/// asks being answered through boxbox, remembered at most, and for how long.
const MAX_ANSWERING: usize = 256;
const ANSWERING_FOR_MS: i64 = 60 * 1000;
/// a fault inside this long after the person stopped the turn is theirs
/// (in v1's logs most faults followed the person's own interrupt).
const OWN_ACTION_MS: i64 = 15 * 1000;

#[derive(Clone, Copy, Debug, Default)]
struct Floors {
    sessions: u64,
    statuses: u64,
    permissions: u64,
    questions: u64,
}

#[derive(Clone, Copy, Debug)]
enum Domain {
    Sessions,
    Statuses,
    Permissions,
    Questions,
}

#[derive(Debug)]
struct Session {
    host: String,
    id: String,
    /// the thread as its source knows it (its raw info dropped: only an
    /// adoption persists it).
    thread: ThreadFacts,
    updated: f64,
    /// the parent session's key, for a subagent.
    parent: Option<String>,
    /// where the session works: a checkout's path for a thread in a worktree.
    directory: String,
    /// the project's last path segment: what titles call the thread.
    repo: String,
    /// the project root and the directory the session works in, as the
    /// daemon wrote them: the places a host has shown to be real.
    places: [String; 2],
    tail: Tail,
    turn: Turn,
    /// the source's transcript revision this state reflects
    /// (`docs/protocol.md`, section 14a): the highest seen on an event the
    /// fleet journaled for the thread, a session info it applied, or a read
    /// it folded in itself; never from a read it only passed to a device.
    /// none when it was never seen with one: a gap then resets the thread.
    srev: Option<u64>,
}

/// a session's window tail and what it needs to stay true.
#[derive(Debug, Default)]
struct Tail {
    /// oldest first, at most `TAIL_ITEMS`.
    items: Vec<TailItem>,
    /// the newest messages, oldest first, at most `SAID`.
    said: VecDeque<Said>,
    /// when the session's entry last went into the journal, ms.
    sent: i64,
    /// whether the tail holds the daemon's read of the session yet.
    hydration: Hydration,
}

/// where a session's tail stands with the daemon's read of it.
#[derive(Debug, Default)]
enum Hydration {
    /// never asked for: the session has had no window, or its read must be
    /// taken again (another epoch).
    #[default]
    Unread,
    /// the read is out. what changed the tail since it was asked is kept,
    /// to replay on top of it.
    Asked {
        since: Vec<TailOp>,
        /// more changed than `TAIL_OPS` holds: the read will be dropped.
        overflowed: bool,
        /// reads asked for this session in a row, this one included.
        attempts: u8,
    },
    /// the tail holds the read at upstream seq `floor`: a sequenced
    /// transcript event at or below it is in the tail already.
    Read { floor: u64 },
    /// the read failed; it is asked again once the host is read afresh.
    Failed,
}

/// one change to a tail while its read is out, reduced to what the tail
/// keeps (an item is at most `TAIL_TEXT` characters).
#[derive(Debug)]
enum TailOp {
    Said {
        seq: Option<u64>,
        id: String,
        role: TailRole,
        queued: bool,
    },
    Put {
        seq: Option<u64>,
        item: TailItem,
    },
    /// contiguous deltas of one part, the end of their text.
    Stream {
        message: String,
        part: String,
        delta: String,
        offset: u64,
    },
    Removed {
        seq: Option<u64>,
        message: String,
    },
}

/// a session whose window needs its tail read from the daemon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailRequest {
    pub key: String,
    pub host: String,
    /// the daemon's session id.
    pub session: String,
    /// the quiet re-read's newest messages (`docs/protocol.md`, section
    /// 10) instead of a window's tail.
    pub newest: bool,
}

/// who wrote a message, and whether it is a prompt still queued behind the
/// running turn (it shows under the tail, not in it, and lands later under
/// its own id).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Said {
    id: String,
    role: TailRole,
    queued: bool,
}

/// what the model knows of a session's turns, for needs and read marks.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Turn {
    /// the newest message: its id and the daemon's `time.created`.
    newest: Option<(String, f64)>,
    /// the newest assistant reply that completed.
    reply: Option<Reply>,
    /// the device whose send started the turn now running. it outlives a park on agents or
    /// jobs, so the turn that wakes from the park still ends as the device's (push: done).
    armed: Option<Device>,
    /// the device whose send landed for the next turn to start, taken when it starts. unlike
    /// `armed` it never outlives that start: a turn the agent starts itself, woken from a park
    /// by a child's report, was started by nobody here.
    sent: Option<Device>,
    /// the reply a turn's end was last judged for, so it is judged once.
    judged: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Reply {
    id: String,
    /// the daemon's `time.created`: a mark at or past it has seen the reply.
    created: f64,
    finish: Option<String>,
}

/// a device a person acted from: its id and the class it names itself by.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub class: String,
}

/// what the review routes need of a session: where it works, and the checkout its open
/// review need names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewTarget {
    pub directory: String,
    pub checkout: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Arm {
    key: String,
    device: Device,
    at: i64,
}

/// what the actor must do after an input: the model's news for the world
/// outside it.
#[derive(Debug)]
pub enum Effect {
    /// a need was raised or served: persist it, count it.
    Need(Moved),
    /// judge this for push.
    Notice(Notice),
    /// the agent carried on in this thread: a waiting "done" is dropped.
    Continued(String),
    /// a device's read mark moved: persist it.
    Read {
        key: String,
        mark: Mark,
        source: &'static str,
    },
    /// a session's marks are gone with it.
    ReadForgotten(String),
    /// read this session's newest messages for its window's tail.
    ReadTail(TailRequest),
    /// a thread was cleared off home: persist its mark.
    Cleared { key: String, clear: Clear },
    /// a thread's mark is spent (it came back, went away, or the cap took
    /// it): forget it.
    Uncleared(String),
    /// a person brought a thread back: the sweep leaves it until it is updated.
    Kept { key: String, kept: Kept },
    /// a thread's kept mark is spent (updated, gone, or the cap took it).
    Unkept(String),
    /// a person acknowledged the away summary: every row of it leaves.
    AwayAcked,
    /// a thread was opened from history and the fleet holds it past its host's
    /// newest listing: persist its info.
    Adopted { key: String, info: Box<RawValue> },
    /// an adopted thread went (the cap, an archive, its host holds it itself): forget it.
    Unadopted(String),
    /// a repo's colour was given, chosen or let go: write it.
    Colour(colours::Write),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Activity {
    Busy {
        since: f64,
    },
    /// idle but waiting on `agents` under it still working or queued, and `jobs` in the background
    Parked {
        since: f64,
        jobs: u32,
        agents: u32,
    },
}

#[derive(Debug)]
struct Status {
    /// the activity as the source told it, retry and all: what the thread's
    /// `activity` says.
    neutral: wire::Activity,
    /// what it means for ranks, turns and needs.
    activity: Activity,
    /// prompts waiting behind the running turn, as the source counts them.
    queued: u32,
}

#[derive(Debug)]
struct Pending {
    /// the ask as its source told it: what the wire carries and its need says.
    neutral: Box<wire::Ask>,
    /// arrival order, so the oldest ask leads the window order.
    serial: u64,
}

/// one part as a window shows it, reduced to what the window needs, with
/// the server's own bookkeeping (`streamed`). parts a window does not show
/// (step markers, snapshots, the context the daemon adds to a prompt, a
/// prompt still queued) never enter a tail. streamed text grows the part as
/// it arrives. on the wire it is a `wire::TailItem`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct TailItem {
    part_id: String,
    message_id: String,
    /// text, reasoning, tool or file: a picture and a recording show as the
    /// file they are, as the window has always drawn them.
    kind: TailKind,
    role: TailRole,
    tool: Option<String>,
    state: Option<String>,
    /// at most 280 characters: the end of the agent's text, the start of
    /// your prompt, or the tool's title.
    text: String,
    /// the whole text's length in utf-16 units, where the next streamed
    /// delta lands (cmx2's `offset`).
    streamed: u64,
    from: Option<String>,
}

impl TailItem {
    /// whether a window renders anything for this item: thinking never,
    /// text once it has words, a tool or a file always. an item that does
    /// not show can change without an entry (the next one carries it).
    fn shows(&self) -> bool {
        match self.kind {
            TailKind::Reasoning => false,
            TailKind::Text => !self.text.trim().is_empty(),
            TailKind::Tool | TailKind::File | TailKind::Image | TailKind::Audio => true,
        }
    }

    fn wire(&self) -> wire::TailItem {
        wire::TailItem {
            part_id: self.part_id.clone(),
            message_id: self.message_id.clone(),
            kind: self.kind,
            role: self.role,
            tool: self.tool.clone(),
            state: self.state.clone(),
            text: self.text.clone(),
            from: self.from.clone(),
        }
    }
}

#[derive(Debug, Default)]
pub struct Model {
    /// each agent as the stream carries it, in first-seen order.
    agents: Vec<wire::Agent>,
    sessions: HashMap<String, Session>,
    /// sessions that are not plain idle, by key. kept apart from `sessions`
    /// because a status can arrive for a session the index does not hold.
    statuses: HashMap<String, Status>,
    /// by `(host, ask id)`.
    asks: HashMap<(String, String), Pending>,
    floors: HashMap<String, Floors>,
    /// each host's store epoch, as its last read said: a tail read from
    /// another epoch lines up with nothing here.
    epochs: HashMap<String, String>,
    order: Vec<String>,
    serial: u64,
    needs: Needs,
    reads: Reads,
    /// the threads cleared off home (`clears.rs`).
    clears: Clears,
    /// each repo's colour (`colours.rs`).
    colours: Colours,
    /// the keys of sessions held because a person opened them from history,
    /// oldest first, at most `MAX_ADOPTED`. a host read (a reconnect, a new
    /// epoch) rebuilds from the daemon's newest listing, which does not hold
    /// them, so it carries these over.
    adopted: Vec<String>,
    /// adopted threads the store kept that their host has not been read for
    /// since the start: `(session key, thread)`, held at that host's first
    /// read; none for a kept row that no longer decodes, forgotten then.
    restored: Vec<(String, Option<ThreadFacts>)>,
    /// sends through boxbox by client id, until their message lands.
    arms: HashMap<String, Arm>,
    /// asks being answered through boxbox, by `(host, ask id)`.
    answering: HashMap<(String, String), (Device, i64)>,
    /// when a person last stopped each session's turn.
    own: HashMap<String, i64>,
    /// the devices looking at boxbox now, as push last saw them.
    looking: Vec<Looking>,
    /// the person's home prefs: the sweep's rule, and whether job notices count.
    home: HomePrefs,
    /// the sweep's waits (`SweepPace`).
    pace: SweepPace,
    /// per home window with no status, the `time.updated` it had when a sweep
    /// first found it idle and when that was (server ms): `any3h`'s last
    /// resort for when it settled. kept by the sweep alone, for the windows it
    /// looked at, so at most `MAX_ORDER`.
    quiet: HashMap<String, (f64, i64)>,
    /// sessions whose tail took streamed text their journaled entry does
    /// not have yet. at most one per session held, so it is bounded by
    /// `MAX_SESSIONS`; a session that goes leaves it.
    held: BTreeSet<String>,
    /// how often a session's held tail goes out, when not `TAIL_EVERY_MS`:
    /// only a recorded tape, replayed at the cadence it was recorded at.
    tail_every: Option<i64>,
    /// the time, ms, as the actor last said.
    now: i64,
    effects: Vec<Effect>,
    /// the host read the changes now on their way hold, if any: its repos
    /// get their colours together, the busiest first (`assign_colours`).
    colour_read: Option<String>,
    /// per host, the newest upstream seq the model applied: a read stamped
    /// at or below it reflects nothing the journal lacks.
    applied: HashMap<String, u64>,
    /// hosts whose stream is applying a compact replay from a cursor.
    replaying: HashSet<String>,
    /// per thread, the revision a session info gave during a compact replay
    /// past what the journal held, judged when the replay is caught up.
    unseen: HashMap<String, u64>,
    /// threads whose newest messages the quiet re-read asked for, with the
    /// revision the host's listing gave (`docs/protocol.md`, section 10).
    /// one per thread, gone with the thread or the answer.
    newest: HashMap<String, u64>,
}

/// the facts of a message a need or a mark needs.
#[derive(Debug)]
struct MessageFacts {
    id: String,
    role: &'static str,
    time: MessageTime,
    client_id: Option<String>,
    queued: bool,
    finish: Option<String>,
}

#[derive(Debug)]
struct MessageTime {
    created: f64,
    completed: Option<f64>,
}

impl MessageFacts {
    fn of(message: &wire::Message) -> Self {
        Self {
            id: message.id.clone(),
            role: message.role.as_str(),
            time: MessageTime {
                created: message.created,
                completed: message.completed,
            },
            client_id: message.client_id.clone(),
            queued: message.queued,
            finish: message.finish.clone(),
        }
    }
}

/// the few fields of a part a tail needs. from a daemon's json they are
/// read loosely: a part type this build does not know still has an id, a
/// message and a type.
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct PartFacts<'a> {
    id: String,
    #[serde(rename = "messageID")]
    message_id: String,
    #[serde(rename = "type")]
    kind: String,
    /// borrowed where it can be: a part's text is megabytes, and comparing
    /// two facts or reading a tail's end needs no copy of it.
    #[serde(borrow)]
    text: Option<Cow<'a, str>>,
    tool: Option<String>,
    state: Option<ToolFacts>,
    filename: Option<String>,
    /// context the daemon added to a prompt (the turn context, a mentioned
    /// file): not something you typed, so not something a window shows.
    #[serde(default)]
    synthetic: bool,
    /// the part came from another agent (a report, a note) or started this
    /// one (its brief): cmx2's mail envelope.
    mail: Option<MailFacts>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct MailFacts {
    kind: Option<String>,
    from: Option<String>,
}

impl MailFacts {
    /// the sender's name when the mail is another agent's report or note;
    /// a brief (`task`) and the runtime's own mail are not from an agent
    /// the window should name.
    fn agent(&self) -> Option<String> {
        match self.kind.as_deref() {
            Some("report" | "message") => self.from.as_deref().map(|path| {
                let name = path.strip_prefix("/root/").unwrap_or(path);
                if name == "/root" {
                    "root".to_owned()
                } else {
                    name.to_owned()
                }
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct ToolFacts {
    status: Option<String>,
    title: Option<String>,
}

/// what a tail reads of a part: the facts of each neutral kind, and of an
/// unknown one the facts its json holds, read loosely as always. none when
/// even those do not decode.
pub(crate) fn part_facts(part: &Part) -> Option<PartFacts<'_>> {
    Some(match part {
        Part::Text(p) => PartFacts {
            synthetic: p.synthetic,
            mail: p.mail.as_ref().map(|m| MailFacts {
                kind: Some(m.kind.clone()),
                from: m.from.clone(),
            }),
            ..facts_of(part, "text", p.text.as_deref())
        },
        Part::Reasoning(p) => facts_of(part, "reasoning", p.text.as_deref()),
        Part::Tool(p) => PartFacts {
            tool: Some(p.tool.clone()),
            state: Some(ToolFacts {
                status: Some(p.state.status.as_str().to_owned()),
                title: p.state.title.clone(),
            }),
            ..facts_of(part, "tool", None)
        },
        // contract 1 shows a picture and a recording as the file they are
        Part::File(p) => PartFacts {
            filename: Some(p.filename.clone()),
            ..facts_of(part, "file", None)
        },
        Part::Image(p) => PartFacts {
            filename: p.filename.clone(),
            ..facts_of(part, "file", None)
        },
        Part::Audio(_) => facts_of(part, "file", None),
        Part::Compaction(_) => facts_of(part, "compaction", None),
        Part::Marker(p) => facts_of(
            part,
            match p.marker {
                wire::MarkerKind::StepStart => "step-start",
                wire::MarkerKind::StepFinish => "step-finish",
                wire::MarkerKind::Patch => "patch",
                wire::MarkerKind::Subtask => "subtask",
                wire::MarkerKind::Reset => "reset",
            },
            None,
        ),
        Part::Unknown(p) => return PartFacts::deserialize(&*p.raw).ok(),
    })
}

/// the facts every part has, with the text it carries (if any) borrowed.
fn facts_of<'a>(part: &'a Part, kind: &str, text: Option<&'a str>) -> PartFacts<'a> {
    PartFacts {
        id: part.id().to_owned(),
        message_id: part.message_id().to_owned(),
        kind: kind.to_owned(),
        text: text.map(Cow::Borrowed),
        tool: None,
        state: None,
        filename: None,
        synthetic: false,
        mail: None,
    }
}

/// the repos the fleet holds a session of, which keeps their colours from
/// the cap.
fn repos_in_use(sessions: &HashMap<String, Session>) -> colours::InUse {
    let mut in_use = colours::InUse::new();
    for session in sessions.values() {
        if let Some(place) = &session.thread.place {
            in_use
                .entry(session.host.clone())
                .or_default()
                .insert(place.root.clone());
        }
    }
    in_use
}

/// `<host>:<sessionID>`, the identity every surface uses.
#[must_use]
pub fn session_key(host: &str, session: &str) -> String {
    format!("{host}:{session}")
}

#[cfg(test)]
fn raw(text: &str) -> Option<Box<RawValue>> {
    RawValue::from_string(text.to_owned()).ok()
}

impl Model {
    #[cfg(test)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// a model that starts from what the store kept of needs, marks, clears,
    /// adopted threads and repo colours.
    #[must_use]
    pub fn restored(
        needs: Needs,
        reads: Reads,
        clears: Clears,
        adopted: Vec<(String, Option<ThreadFacts>)>,
        colours: Colours,
    ) -> Self {
        Self {
            needs,
            reads,
            clears,
            colours,
            restored: adopted,
            ..Self::default()
        }
    }

    /// the threads whose streamed text their journaled state lacks yet.
    #[cfg(test)]
    pub fn held(&self) -> &BTreeSet<String> {
        &self.held
    }

    /// a replay of a tape recorded at another tail cadence keeps it.
    #[cfg(test)]
    pub fn set_tail_every(&mut self, ms: i64) {
        self.tail_every = Some(ms);
    }

    fn tail_every(&self) -> i64 {
        self.tail_every.unwrap_or(TAIL_EVERY_MS)
    }

    /// the time now, ms since the epoch; every input after it is stamped with it.
    pub fn at(&mut self, now: i64) {
        self.now = now;
    }

    /// what the world outside must hear since the last drain.
    pub fn drain(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// the whole fleet, as `reset` and `GET /api/fleet` carry it: threads by
    /// key, asks oldest first.
    #[must_use]
    pub fn snapshot(&self) -> wire::Fleet {
        let mut keys: Vec<&String> = self.sessions.keys().collect();
        keys.sort();
        let threads = keys
            .into_iter()
            .filter_map(|key| self.thread(key))
            .collect();
        let mut asks: Vec<&Pending> = self.asks.values().collect();
        asks.sort_by_key(|p| p.serial);
        wire::Fleet {
            agents: self.agents.clone(),
            threads,
            asks: asks.into_iter().map(|p| (*p.neutral).clone()).collect(),
            order: self.order.clone(),
        }
    }

    /// the thread as the stream carries it: the one place a session becomes
    /// a `wire::Thread`. none when the fleet does not hold it.
    #[must_use]
    pub fn thread(&self, key: &str) -> Option<wire::Thread> {
        let session = self.sessions.get(key)?;
        let facts = &session.thread;
        let status = self.statuses.get(key);
        let agents = self
            .statuses
            .iter()
            .filter(|(child, s)| {
                matches!(s.activity, Activity::Busy { .. })
                    && self.sessions.get(*child).and_then(|c| c.parent.as_deref()) == Some(key)
            })
            .count();
        let processes = match status.map(|s| s.activity) {
            Some(Activity::Parked { jobs, .. }) => jobs,
            _ => 0,
        };
        Some(wire::Thread {
            key: key.to_owned(),
            agent: session.host.clone(),
            id: session.id.clone(),
            title: facts.title.clone(),
            created: facts.created,
            updated: facts.updated,
            said: facts.said,
            generation: facts.generation.clone(),
            parent: facts.parent.clone(),
            forked_from: facts.forked_from.clone(),
            place: facts.place.clone(),
            origin: facts.origin.clone(),
            activity: status.map_or(wire::Activity::Idle, |s| s.neutral.clone()),
            // a source that counts the prompts behind a running turn says so with the status
            queued: status.map_or(facts.queued, |s| s.queued.max(facts.queued)),
            sends: None,
            model: facts.model.clone(),
            effort: facts.effort.clone(),
            context: facts.context.clone(),
            cost: facts.cost,
            tokens: facts.tokens.clone(),
            vcs: facts.vcs.clone(),
            changes: facts.changes.clone(),
            browse_only: facts.browse_only,
            agents: u32::try_from(agents).unwrap_or(u32::MAX),
            processes,
            tail: session.tail.items.iter().map(TailItem::wire).collect(),
            needs: self.needs.of(key),
            read: self.reads.merged(key),
            cleared: self.cleared_mark(key),
        })
    }

    /// the thread's whole change, for the encoder to journal as it sees fit.
    fn thread_change(&self, key: &str) -> Option<Change> {
        self.thread(key).map(|thread| Change::Thread { thread })
    }

    /// every repo's colour, by host, then root.
    #[must_use]
    pub fn colour_list(&self) -> Vec<wire::RepoColour> {
        self.colours.list()
    }

    /// colours for the repos these changes show that have none yet, to be
    /// sent ahead of them. a host read gives its repos theirs most threads
    /// first, then by root, so the busiest keep their hash colour. a host
    /// read or a thread change that shows a repo which has one marks it
    /// used (written at most daily), which is what the cap and the trim at
    /// start evict by (`colours.rs`), so a repo in use is always recent even
    /// on a host that never reconnects.
    pub fn assign_colours(&mut self, changes: &[Change]) -> Vec<wire::RepoColour> {
        let read = self.colour_read.take();
        if !self.colours.is_assigning() {
            return Vec::new();
        }
        let mut batches: Vec<(String, Vec<String>)> = Vec::new();
        if let Some(host) = read {
            let mut roots: Vec<(String, usize)> = Vec::new();
            for change in changes {
                let Change::Thread { thread } = change else {
                    continue;
                };
                if thread.agent != host {
                    continue;
                }
                let Some(root) = self.root_of(&thread.key) else {
                    continue;
                };
                match roots.iter_mut().find(|(r, _)| r == root) {
                    Some((_, threads)) => *threads += 1,
                    None => roots.push((root.to_owned(), 1)),
                }
            }
            roots.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            batches.push((host, roots.into_iter().map(|(root, _)| root).collect()));
        }
        let read = batches.first().map(|(host, _)| host.clone());
        for change in changes {
            let Change::Thread { thread } = change else {
                continue;
            };
            if read.as_deref() == Some(thread.agent.as_str()) {
                continue;
            }
            if let Some(root) = self.root_of(&thread.key) {
                batches.push((thread.agent.clone(), vec![root.to_owned()]));
            }
        }
        let mut assigned = Vec::new();
        for (host, roots) in batches {
            for root in roots {
                let sessions = &self.sessions;
                let in_use = || repos_in_use(sessions);
                if let Some((colour, writes)) = self.colours.assign(&host, &root, self.now, in_use)
                {
                    info!(host, root, colour = colour.auto, "repo colour given");
                    self.effects.extend(writes.into_iter().map(Effect::Colour));
                    assigned.push(colour);
                } else if let Some(write) = self.colours.seen(&host, &root, self.now) {
                    self.effects.push(Effect::Colour(write));
                }
            }
        }
        assigned
    }

    /// sets the colour a person chose for a repo, or none for automatic: the
    /// repo's colour now, and whether it moved (a choice that moved nothing
    /// still writes its row, so its answer can mean kept). only a
    /// repo boxbox has given a colour or holds a session of can be chosen
    /// for, so a request cannot fill the table with rows for no repo.
    ///
    /// # Errors
    /// the repo is neither, or its subject is longer than the table holds.
    pub fn choose_colour(
        &mut self,
        host: &str,
        root: &str,
        chosen: Option<u8>,
    ) -> Result<(wire::RepoColour, bool), ColourRefused> {
        let known = self.colours.has(host, root)
            || self
                .sessions
                .values()
                .any(|s| s.host == host && s.thread.place.as_ref().is_some_and(|p| p.root == root));
        if !known || !colours::keepable(host, root) {
            return Err(ColourRefused::UnknownRepo);
        }
        let sessions = &self.sessions;
        let in_use = || repos_in_use(sessions);
        let (colour, writes, moved) = self.colours.choose(host, root, chosen, self.now, in_use);
        self.effects.extend(writes.into_iter().map(Effect::Colour));
        Ok((colour, moved))
    }

    /// the repo a session works in: its project's root.
    fn root_of(&self, key: &str) -> Option<&str> {
        let place = self.sessions.get(key)?.thread.place.as_ref()?;
        Some(place.root.as_str())
    }

    /// every project root and session directory on `host`, as the daemon
    /// spells them: what a lookup that reads the host's files may be
    /// pointed at without making the daemon open a directory it never
    /// heard of.
    #[must_use]
    pub fn places(&self, host: &str) -> HashSet<String> {
        self.sessions
            .values()
            .filter(|session| session.host == host)
            .flat_map(|session| session.places.iter().cloned())
            .collect()
    }

    #[must_use]
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// a connection's status: for cmx2, its host as the one agent it carries,
    /// built as `GET /api/agents` builds it. an agent that did not change
    /// is not sent again.
    pub fn connection(&mut self, status: ConnectionStatus) -> Vec<Change> {
        let Some(host) = status.host else {
            return Vec::new();
        };
        let facts = crate::source::cmx2::translate::agent(&host.name);
        let agent = wire::Agent {
            key: facts.key,
            label: facts.label,
            kind: facts.kind,
            source: facts.source,
            mark: facts.mark,
            palette: facts.palette,
            status: status.status,
            connection: status.connection,
            capabilities: facts.capabilities,
            runs: None,
        };
        match self.agents.iter_mut().find(|a| a.key == agent.key) {
            Some(held) if *held == agent => return Vec::new(),
            Some(held) => *held = agent.clone(),
            None => self.agents.push(agent.clone()),
        }
        vec![Change::Agent { agent }]
    }

    /// a host left the config: everything held for it goes, each thread and
    /// open ask on the wire first, then the agent.
    pub fn host_removed(&mut self, host: &str) -> Vec<Change> {
        let mut threads: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.host == host)
            .map(|(key, _)| key.clone())
            .collect();
        threads.sort();
        let mut asks: Vec<&Pending> = self
            .asks
            .iter()
            .filter(|((h, _), _)| h == host)
            .map(|(_, p)| p)
            .collect();
        asks.sort_by_key(|p| p.serial);
        let asks: Vec<String> = asks.into_iter().map(|p| p.neutral.id.clone()).collect();
        self.agents.retain(|a| a.key != host);
        self.floors.remove(host);
        self.epochs.remove(host);
        self.applied.remove(host);
        self.replaying.remove(host);
        self.drop_host(host);
        let prefix = format!("{host}:");
        for (key, _) in self
            .restored
            .extract_if(.., |(key, _)| key.starts_with(&prefix))
            .collect::<Vec<_>>()
        {
            self.effects.push(Effect::Unadopted(key));
        }
        self.needs.forget_host(host);
        self.reads.forget_host(host);
        for key in self.clears.forget_host(host) {
            self.effects.push(Effect::Uncleared(key));
        }
        for key in self.clears.forget_host_kept(host) {
            self.effects.push(Effect::Unkept(key));
        }
        self.quiet.retain(|key, _| !key.starts_with(&prefix));
        let mut changes: Vec<Change> = threads
            .into_iter()
            .map(|key| Change::ThreadRemoved { key })
            .collect();
        changes.extend(asks.into_iter().map(|id| self.unknown_settle(host, id)));
        changes.push(Change::AgentRemoved {
            agent: host.to_owned(),
        });
        self.reorder(&mut changes);
        changes
    }

    /// an ask boxbox lost track of: it went with its thread or its host, or
    /// a host read no longer lists it.
    #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
    fn unknown_settle(&self, host: &str, id: String) -> Change {
        Change::AskSettled(wire::AskSettled {
            agent: host.to_owned(),
            id,
            outcome: wire::Outcome::Unknown,
            option: None,
            reason: None,
            by: None,
            at: self.now as f64,
        })
    }

    /// the agent was read afresh: its sessions, statuses and asks are
    /// replaced, and the stream hears it as a quiet re-read
    /// (`docs/protocol.md`, section 10): each thread whole (the encoder
    /// journals nothing for one that did not change), the ones gone removed,
    /// asks gone settled as unknown and new ones raised, and every thread the
    /// fleet held before the read reset, since no transcript revision says
    /// which of them moved.
    #[allow(
        clippy::too_many_lines,
        reason = "one pass: carry, rebuild, then the diff"
    )]
    pub fn agent_read(&mut self, host: &str, read: Snapshot) -> Vec<Change> {
        let host = host.to_owned();
        let held_threads: HashSet<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.host == host)
            .map(|(key, _)| key.clone())
            .collect();
        // what the re-read judges each held thread's transcript by: its revision and whether it streamed
        let held_revs: HashMap<String, (Option<u64>, bool)> = held_threads
            .iter()
            .filter_map(|key| {
                let session = self.sessions.get(key)?;
                Some((key.clone(), (session.srev, self.is_busy(key))))
            })
            .collect();
        let held_asks: HashMap<String, wire::Ask> = self
            .asks
            .iter()
            .filter(|((h, _), _)| *h == host)
            .map(|((_, id), p)| (id.clone(), (*p.neutral).clone()))
            .collect();
        // seqs of another epoch line up with nothing: every tail is read again
        let epoch_moved = match &read.epoch {
            Some(epoch) => self
                .epochs
                .insert(host.clone(), epoch.clone())
                .is_some_and(|before| before != *epoch),
            None => false,
        };
        // threads opened from history are not in the daemon's newest listing: they wait out the rebuild
        let carried = self.take_adopted(&host);
        let mut tails: HashMap<String, (Tail, Turn)> = self
            .sessions
            .iter_mut()
            .filter(|(_, s)| s.host == host)
            .map(|(key, s)| {
                let mut tail = std::mem::take(&mut s.tail);
                // a failed read is asked once more per connection
                if epoch_moved || matches!(tail.hydration, Hydration::Failed) {
                    tail.hydration = Hydration::Unread;
                }
                (key.clone(), (tail, std::mem::take(&mut s.turn)))
            })
            .collect();
        self.drop_host(&host);
        self.floors.insert(
            host.clone(),
            Floors {
                sessions: read.floors.threads,
                statuses: read.floors.activities,
                permissions: read.floors.permissions,
                questions: read.floors.questions,
            },
        );
        let floor = read
            .floors
            .threads
            .min(read.floors.activities)
            .min(read.floors.permissions)
            .min(read.floors.questions);
        self.applied.insert(host.clone(), floor);

        let mut keys = Vec::with_capacity(read.threads.len());
        for thread in read.threads {
            // the daemon's listings leave archived sessions out; one that slips in is not held
            if thread.archived {
                continue;
            }
            let key = session_key(&host, &thread.id);
            let carried = tails.remove(&key).unwrap_or_default();
            self.sessions
                .insert(key.clone(), session(&host, thread, carried));
            keys.push(key);
        }
        let listed: HashSet<String> = keys.iter().cloned().collect();
        self.hold_adopted(&host, carried, epoch_moved, &mut keys);
        for held in read.activities {
            let key = session_key(&host, &held.thread);
            if let Some(activity) = activity(&held.activity) {
                self.statuses.insert(
                    key,
                    Status {
                        neutral: held.activity,
                        activity,
                        queued: held.queued,
                    },
                );
            }
        }
        for raised in read.asks {
            self.add_ask(&host, raised.ask);
        }
        let mut evicted = Vec::new();
        self.evict(&mut evicted, None);
        let marked: Vec<String> = self.clears.of_host(&host).map(str::to_owned).collect();
        self.spend_clears(marked);
        self.reread_needs(&host);

        let mut changes = Vec::new();
        let mut gone: Vec<&String> = held_threads
            .iter()
            .filter(|key| !keys.contains(key))
            .collect();
        gone.sort();
        changes.extend(
            gone.into_iter()
                .map(|key| Change::ThreadRemoved { key: key.clone() }),
        );
        let mut reread = Vec::new();
        for key in &keys {
            let Some(change) = self.thread_change(key) else {
                continue;
            };
            changes.push(change);
            let Some(&(held, busy_before)) = held_revs.get(key) else {
                continue;
            };
            let listed_rev = listed
                .contains(key)
                .then(|| self.sessions.get(key).and_then(|s| s.thread.rev))
                .flatten();
            match (held, listed_rev) {
                // no transcript write in the gap; only a part streaming across it is read
                (Some(held), Some(now)) if held == now => {
                    if busy_before || self.is_busy(key) {
                        self.ask_newest(key, now);
                        reread.push(key.clone());
                    }
                }
                // moved, or no revision to judge by: devices read it again
                _ => {
                    changes.push(Change::ThreadReset { key: key.clone() });
                    if let Some(session) = self.sessions.get_mut(key) {
                        session.srev = listed_rev;
                    }
                    reread.push(key.clone());
                }
            }
        }
        // their tails are read again; every other tail is kept
        for key in reread {
            if let Some(session) = self.sessions.get_mut(&key)
                && !matches!(session.tail.hydration, Hydration::Asked { .. })
            {
                session.tail.hydration = Hydration::Unread;
            }
        }
        let mut asks: Vec<&Pending> = self
            .asks
            .values()
            .filter(|p| p.neutral.agent == host)
            .collect();
        asks.sort_by_key(|p| p.serial);
        let asks: Vec<wire::Ask> = asks.into_iter().map(|p| (*p.neutral).clone()).collect();
        let mut settled: Vec<&String> = held_asks
            .keys()
            .filter(|id| !asks.iter().any(|a| a.id == **id))
            .collect();
        settled.sort();
        for id in settled {
            changes.push(self.unknown_settle(&host, id.clone()));
        }
        for ask in asks {
            if held_asks.get(&ask.id) != Some(&ask) {
                changes.push(Change::Ask { ask });
            }
        }
        changes.extend(evicted);
        self.reorder(&mut changes);
        self.journaled(&changes);
        self.want_tails(keys);
        self.colour_read = Some(host);
        changes
    }

    /// one source event for `host` (the agent).
    ///
    /// the connection, snapshot and tail events have their own entries
    /// (`connection`, `agent_read`, `tail`); here they change nothing.
    pub fn source(&mut self, host: &str, seq: Option<u64>, event: SourceEvent) -> Vec<Change> {
        let mut changes = Vec::new();
        if let Some(seq) = seq {
            let applied = self.applied.entry(host.to_owned()).or_default();
            *applied = (*applied).max(seq);
        }
        let moved_before = self.effects.len();
        let status_before = match &event {
            SourceEvent::Activity { thread, .. } | SourceEvent::TurnEnded { thread } => {
                let key = session_key(host, thread);
                let before = self.statuses.get(&key).map(|s| s.activity);
                Some((key, before))
            }
            _ => None,
        };
        match event {
            SourceEvent::Message { .. }
            | SourceEvent::Part { .. }
            | SourceEvent::Delta { .. }
            | SourceEvent::MessageRemoved { .. }
            | SourceEvent::Btw { .. }
            | SourceEvent::BtwDelta { .. } => {
                self.transcript(host, seq, event, &mut changes);
            }
            SourceEvent::Fault { .. }
            | SourceEvent::Notice { .. }
            | SourceEvent::ReviewSettled { .. } => {
                self.notable(host, seq, event);
            }
            SourceEvent::Thread { thread, born } => {
                if !self.stale(host, Domain::Sessions, seq) {
                    let key = session_key(host, &thread.id);
                    let born = born && !self.sessions.contains_key(&key);
                    self.upsert_session(host, *thread, &mut changes);
                    // seen from its birth: everything it says streams after this, so no read is needed
                    if born && let Some(session) = self.sessions.get_mut(&key) {
                        session.tail.hydration = Hydration::Read { floor: 0 };
                    }
                }
            }
            SourceEvent::ThreadRemoved { thread } => {
                if !self.stale(host, Domain::Sessions, seq) {
                    self.remove_session(&session_key(host, &thread), &mut changes);
                }
            }
            SourceEvent::Activity {
                thread,
                activity,
                queued,
            } => {
                if !self.stale(host, Domain::Statuses, seq) {
                    let status = self::activity(&activity).map(|a| Status {
                        neutral: activity,
                        activity: a,
                        queued,
                    });
                    self.set_status(host, &thread, status, &mut changes);
                }
            }
            SourceEvent::TurnEnded { thread } => {
                let key = session_key(host, &thread);
                // a turn's end leaves idle; a parked status that came with it stays
                let busy = matches!(
                    self.statuses.get(&key),
                    Some(Status {
                        activity: Activity::Busy { .. },
                        ..
                    })
                );
                if busy && !self.stale(host, Domain::Statuses, seq) {
                    self.set_status(host, &thread, None, &mut changes);
                }
            }
            SourceEvent::AskRaised { .. } | SourceEvent::AskSettled { .. } => {
                self.asked(host, seq, event, &mut changes);
            }
            // the source cannot prove the journal holds every row of it
            SourceEvent::ThreadReset { thread } => {
                let key = session_key(host, &thread);
                if self.sessions.contains_key(&key) {
                    changes.push(Change::ThreadReset { key });
                }
            }
            // not this model's yet, or carried by their own entries
            SourceEvent::Connection(_)
            | SourceEvent::Agents(_)
            | SourceEvent::Snapshot(_)
            | SourceEvent::Send { .. }
            | SourceEvent::Reactions { .. }
            | SourceEvent::TailRead(_)
            | SourceEvent::TailUnread { .. }
            | SourceEvent::NewestRead(_)
            | SourceEvent::NewestUnread { .. }
            | SourceEvent::Skipped => {}
            SourceEvent::Replaying => {
                self.replaying.insert(host.to_owned());
            }
            SourceEvent::CaughtUp => self.caught_up(host, &mut changes),
        }
        self.after_event(moved_before, status_before, &mut changes);
        self.journaled(&changes);
        let touched: Vec<String> = changes.iter().filter_map(touched_key).collect();
        self.want_tails(touched);
        changes
    }

    /// an ask raised or settled, past its kind's floor.
    fn asked(
        &mut self,
        host: &str,
        seq: Option<u64>,
        event: SourceEvent,
        changes: &mut Vec<Change>,
    ) {
        match event {
            SourceEvent::AskRaised { ask } => {
                let domain = match ask.kind {
                    wire::AskKind::Permission => Domain::Permissions,
                    wire::AskKind::Question => Domain::Questions,
                };
                if !self.stale(host, domain, seq) {
                    self.ask_arrived(host, *ask, changes);
                }
            }
            SourceEvent::AskSettled { ask, kind, settled } => {
                let domain = match kind {
                    wire::AskKind::Permission => Domain::Permissions,
                    wire::AskKind::Question => Domain::Questions,
                };
                if !self.stale(host, domain, seq) {
                    self.settle(host, &ask, Some(*settled), changes);
                }
            }
            _ => {}
        }
    }

    /// a transcript event: journaled as it came, whatever the floors say (a
    /// client filters it against its own transcript read); a part also
    /// moves its thread's tail.
    /// a transcript event the fleet journals carried the thread's revision
    /// after its write: the state now reflects it.
    fn revised(&mut self, host: &str, thread: &str, rev: Option<u64>) {
        if rev.is_some()
            && let Some(session) = self.sessions.get_mut(&session_key(host, thread))
        {
            session.srev = higher(session.srev, rev);
        }
    }

    fn transcript(
        &mut self,
        host: &str,
        seq: Option<u64>,
        event: SourceEvent,
        changes: &mut Vec<Change>,
    ) {
        match event {
            SourceEvent::Message {
                thread,
                message,
                rev,
            } => {
                self.revised(host, &thread, rev);
                self.said(host, seq, &thread, *message, changes);
            }
            SourceEvent::Part { thread, part, rev } => {
                self.revised(host, &thread, rev);
                let key = session_key(host, &thread);
                let retailed = self.retail(&key, seq, &part);
                changes.push(Change::Part {
                    key: key.clone(),
                    upstream: seq,
                    part: *part,
                });
                if retailed {
                    changes.extend(self.thread_change(&key));
                }
            }
            SourceEvent::Delta {
                thread,
                message,
                part,
                field,
                delta,
                offset,
            } => {
                let key = session_key(host, &thread);
                let grew = field == "text"
                    && self.sessions.get_mut(&key).is_some_and(|s| {
                        s.tail.record_delta(&message, &part, &delta, offset);
                        s.tail.stream(&message, &part, &delta, offset)
                    });
                changes.push(Change::Delta {
                    key: key.clone(),
                    message_id: message,
                    part_id: part,
                    field,
                    delta,
                    offset,
                });
                if grew {
                    self.streamed(&key, changes);
                }
            }
            SourceEvent::MessageRemoved {
                thread,
                message,
                rev,
            } => {
                self.revised(host, &thread, rev);
                let key = session_key(host, &thread);
                changes.push(Change::MessageRemoved {
                    key: key.clone(),
                    upstream: seq,
                    message_id: message.clone(),
                });
                if let Some(session) = self.sessions.get_mut(&key)
                    && !session.tail.holds(seq)
                {
                    session.tail.record(TailOp::Removed {
                        seq,
                        message: message.clone(),
                    });
                    let before = session.tail.items.len();
                    session.tail.items.retain(|t| t.message_id != message);
                    if session.tail.items.len() != before {
                        changes.extend(self.thread_change(&key));
                    }
                }
            }
            // a btw is never the thread's tail or state: the model holds none
            // of it and only journals it (the agent is the system of record)
            SourceEvent::Btw { thread, btw } => changes.push(Change::Btw {
                key: session_key(host, &thread),
                upstream: seq,
                btw: *btw,
            }),
            SourceEvent::BtwDelta { thread, btw, delta } => changes.push(Change::BtwDelta {
                key: session_key(host, &thread),
                btw_id: btw,
                delta,
                offset: None,
            }),
            _ => {}
        }
    }

    /// the events that raise or serve a need and change nothing else here:
    /// a turn's fault, a checkout's review and its end, a job's notice.
    fn notable(&mut self, host: &str, seq: Option<u64>, event: SourceEvent) {
        match event {
            SourceEvent::Fault { thread, words } => {
                let fault = FaultFacts {
                    id: seq.map_or_else(|| format!("t{}", self.now), |seq| seq.to_string()),
                    reason: words,
                };
                self.fault(&session_key(host, &thread), &fault);
            }
            SourceEvent::Notice { thread, notice } => {
                let event_id = seq.map_or_else(|| format!("t{}", self.now), |seq| seq.to_string());
                let key = session_key(host, &thread);
                match notice {
                    SourceNotice::Review { checkout, words } => {
                        self.review(&key, &checkout, &words, &event_id);
                    }
                    SourceNotice::Job {
                        process,
                        reason,
                        title,
                        detail,
                    } => {
                        let words = JobWords {
                            id: format!("{process}:{reason}:{event_id}"),
                            what: format!("{title} {}", job_verb(&reason)),
                            detail,
                        };
                        self.job(&key, &words);
                    }
                }
            }
            SourceEvent::ReviewSettled {
                worktree,
                directory,
            } => self.review_settled(host, &worktree, directory.as_deref()),
            _ => {}
        }
    }

    /// a message was created or changed: journaled as it came, whatever the
    /// floors say (a client filters it against its own transcript read);
    /// it moves the thread's turn and who its parts belong to.
    fn said(
        &mut self,
        host: &str,
        seq: Option<u64>,
        thread: &str,
        message: wire::Message,
        changes: &mut Vec<Change>,
    ) {
        let key = session_key(host, thread);
        let facts = MessageFacts::of(&message);
        changes.push(Change::Message {
            key: key.clone(),
            upstream: seq,
            message,
        });
        self.message(&key, &facts);
        let retold = self.sessions.get_mut(&key).is_some_and(|s| {
            if s.tail.holds(seq) {
                return false;
            }
            s.tail.record(TailOp::Said {
                seq,
                id: facts.id.clone(),
                role: TailRole::of(facts.role),
                queued: facts.queued,
            });
            s.tail.said(&facts)
        });
        if retold {
            changes.extend(self.thread_change(&key));
        }
    }

    /// asks for the tail of each of `keys` that has a window and was never
    /// read: once per session, never for one without a window.
    fn want_tails(&mut self, keys: impl IntoIterator<Item = String>) {
        for key in keys {
            let unread = self
                .sessions
                .get(&key)
                .is_some_and(|s| matches!(s.tail.hydration, Hydration::Unread));
            if unread && self.has_window(&key) {
                self.ask_tail(&key, 1);
            }
        }
    }

    fn ask_tail(&mut self, key: &str, attempts: u8) {
        let Some(session) = self.sessions.get_mut(key) else {
            return;
        };
        session.tail.hydration = Hydration::Asked {
            since: Vec::new(),
            overflowed: false,
            attempts,
        };
        self.effects.push(Effect::ReadTail(TailRequest {
            key: key.to_owned(),
            host: session.host.clone(),
            session: session.id.clone(),
            newest: false,
        }));
    }

    /// the law's membership (`design.md`, the model: windows): in the
    /// order, not a subagent, and working, parked, asking, needing the
    /// person, or touched in the last 12 hours.
    fn has_window(&self, key: &str) -> bool {
        let Some(session) = self.sessions.get(key) else {
            return false;
        };
        if session.parent.is_some() || !self.order.iter().any(|k| k == key) {
            return false;
        }
        #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
        let recent = (self.now as f64) - session.updated < WINDOW_RECENT_MS;
        recent
            || self.statuses.contains_key(key)
            || self.asks.values().any(|p| p.neutral.key == key)
            || self.needs.lead(key).is_some()
    }

    /// the agent's read of a thread's tail. the tail becomes the read,
    /// with what changed while it was out replayed on top when newer.
    pub fn tail(&mut self, host: &str, read: TailRead) -> Vec<Change> {
        let TailRead {
            thread,
            upstream,
            rev,
            messages,
        } = read;
        // a read reflects only what the journal holds when the stream has applied its seq
        let applied = self.applied.get(host).copied();
        let key = session_key(host, &thread);
        let Some(session) = self.sessions.get_mut(&key) else {
            info!(
                session = key,
                "a tail read came for a session that is gone; dropped"
            );
            return Vec::new();
        };
        /* the epoch moves only through a host read, which asks every tail again: a read from another epoch is
        the one before that (or after the daemon reset and before the watcher heard), and the read asked by
        the host read lines up instead */
        if let Some(epoch) = self.epochs.get(&session.host)
            && let Some(upstream) = &upstream
            && *epoch != upstream.epoch
        {
            info!(session = key, read_epoch = upstream.epoch, host_epoch = %epoch, "a tail read from another epoch; dropped");
            return Vec::new();
        }
        let (since, attempts) = match std::mem::take(&mut session.tail.hydration) {
            Hydration::Asked {
                overflowed: true,
                attempts,
                ..
            } => {
                if attempts < TAIL_READ_ATTEMPTS {
                    info!(
                        session = key,
                        attempts,
                        "the tail changed more than its read could be lined up with; reading again"
                    );
                    self.ask_tail(&key, attempts + 1);
                } else {
                    warn!(
                        session = key,
                        attempts,
                        "the tail kept changing faster than it could be read; it keeps what streamed"
                    );
                    session.tail.hydration = Hydration::Read { floor: 0 };
                }
                return Vec::new();
            }
            Hydration::Asked {
                since, attempts, ..
            } => (since, attempts),
            other => {
                session.tail.hydration = other;
                return Vec::new();
            }
        };
        let floor = upstream.map_or(0, |upstream| upstream.seq);
        if applied.is_some_and(|applied| floor != 0 && floor <= applied) {
            session.srev = higher(session.srev, rev);
        }
        let mut fresh = Tail {
            sent: session.tail.sent,
            hydration: Hydration::Read { floor },
            ..Tail::default()
        };
        for message in messages {
            fresh.said(&MessageFacts::of(&message.info));
            for part in message.parts.iter().filter_map(part_facts) {
                if let Some(role) = fresh.role_of(&part.message_id)
                    && let Some(item) = tail_item(part, role)
                {
                    fresh.put(item);
                }
            }
        }
        let replayed = since.len();
        for op in since {
            fresh.replay(op, floor);
        }
        let moved = fresh.items != session.tail.items;
        session.tail = fresh;
        info!(
            session = key,
            seq = floor,
            items = session.tail.items.len(),
            replayed,
            attempts,
            "window tail read"
        );
        let changes: Vec<Change> = if moved {
            self.thread_change(&key).into_iter().collect()
        } else {
            Vec::new()
        };
        self.journaled(&changes);
        changes
    }

    /// a session's tail read failed: it is asked again once its host is
    /// read afresh, never per event.
    pub fn tail_failed(&mut self, key: &str) {
        if let Some(session) = self.sessions.get_mut(key)
            && matches!(session.tail.hydration, Hydration::Asked { .. })
        {
            session.tail.hydration = Hydration::Failed;
        }
    }

    /// a session's tail read could not be queued: the next change to the
    /// session asks again.
    pub fn tail_not_asked(&mut self, key: &str) {
        if let Some(session) = self.sessions.get_mut(key)
            && matches!(session.tail.hydration, Hydration::Asked { .. })
        {
            session.tail.hydration = Hydration::Unread;
        }
    }

    /// whether the thread is running a turn (a retry included): text may be
    /// streaming in it.
    fn is_busy(&self, key: &str) -> bool {
        matches!(
            self.statuses.get(key).map(|s| s.activity),
            Some(Activity::Busy { .. })
        )
    }

    /// the quiet re-read asks for a thread's newest messages: its revision
    /// held still, but a part may have streamed across the gap.
    fn ask_newest(&mut self, key: &str, rev: u64) {
        let Some(session) = self.sessions.get(key) else {
            return;
        };
        self.newest.insert(key.to_owned(), rev);
        self.effects.push(Effect::ReadTail(TailRequest {
            key: key.to_owned(),
            host: session.host.clone(),
            session: session.id.clone(),
            newest: true,
        }));
    }

    /// a host's compact replay is caught up: each thread a session info said
    /// moved past the journal during it is reset if its events did not reach
    /// that revision (a write cmx2 announced only with the info).
    fn caught_up(&mut self, host: &str, changes: &mut Vec<Change>) {
        self.replaying.remove(host);
        let prefix = format!("{host}:");
        let mut judged: Vec<(String, u64)> = self
            .unseen
            .extract_if(|key, _| key.starts_with(&prefix))
            .collect();
        judged.sort();
        for (key, rev) in judged {
            let Some(session) = self.sessions.get_mut(&key) else {
                continue;
            };
            if session.srev.is_none_or(|held| held < rev) {
                session.srev = Some(rev);
                changes.push(Change::ThreadReset { key });
            }
        }
    }

    /// the newest-message reads a quiet re-read asked for before a restart,
    /// asked again: their answers went with the process.
    pub fn ask_newest_again(&mut self) {
        let mut pending: Vec<(String, u64)> =
            self.newest.iter().map(|(k, r)| (k.clone(), *r)).collect();
        pending.sort();
        for (key, rev) in pending {
            self.ask_newest(&key, rev);
        }
    }

    /// a thread's newest messages, read after a gap whose revision held
    /// still (`docs/protocol.md`, section 10): when the read reflects that
    /// same revision, the newest assistant message and every message not
    /// completed go into the journal whole with their parts and no upstream
    /// seq; when it moved in between, the thread is reset.
    pub fn newest_read(&mut self, host: &str, read: TailRead) -> Vec<Change> {
        let key = session_key(host, &read.thread);
        let Some(expected) = self.newest.remove(&key) else {
            return Vec::new();
        };
        let Some(session) = self.sessions.get_mut(&key) else {
            return Vec::new();
        };
        if read.rev != Some(expected) {
            info!(session = key, listed = expected, read = ?read.rev, "the transcript moved while its newest messages were read; the thread is reset");
            session.srev = read.rev;
            return vec![Change::ThreadReset { key }];
        }
        let newest_reply = read
            .messages
            .iter()
            .rposition(|m| m.info.role == wire::Role::Assistant);
        let mut changes = Vec::new();
        for (at, message) in read.messages.into_iter().enumerate() {
            if Some(at) != newest_reply && message.info.completed.is_some() {
                continue;
            }
            changes.push(Change::Message {
                key: key.clone(),
                upstream: None,
                message: message.info,
            });
            for part in message.parts {
                changes.push(Change::Part {
                    key: key.clone(),
                    upstream: None,
                    part,
                });
            }
        }
        info!(
            session = key,
            rev = expected,
            entries = changes.len(),
            "newest messages read across the gap"
        );
        changes
    }

    /// the newest messages could not be read: the thread is reset, so no
    /// streamed text is lost.
    pub fn newest_failed(&mut self, key: &str) -> Vec<Change> {
        if self.newest.remove(key).is_none() || !self.sessions.contains_key(key) {
            return Vec::new();
        }
        vec![Change::ThreadReset {
            key: key.to_owned(),
        }]
    }

    /// when the next held tail is due to go out, ms; none while nothing is held.
    #[must_use]
    pub fn tail_due(&self) -> Option<i64> {
        self.held
            .iter()
            .filter_map(|key| self.sessions.get(key))
            .map(|s| s.tail.sent + self.tail_every())
            .min()
    }

    /// the entries of sessions whose held streamed text is due, now.
    pub fn flush_tails(&mut self) -> Vec<Change> {
        let (now, every) = (self.now, self.tail_every());
        let due: Vec<String> = self
            .held
            .iter()
            .filter(|key| {
                self.sessions
                    .get(*key)
                    .is_none_or(|s| now - s.tail.sent >= every)
            })
            .cloned()
            .collect();
        let mut changes = Vec::with_capacity(due.len());
        for key in due {
            self.held.remove(&key);
            changes.extend(self.thread_change(&key));
        }
        self.journaled(&changes);
        changes
    }

    /// these changes go into the journal now: every thread among them
    /// carries its tail as it stands, so none of it is held any longer.
    fn journaled(&mut self, changes: &[Change]) {
        for change in changes {
            if let Change::Thread { thread } = change {
                self.held.remove(&thread.key);
                if let Some(session) = self.sessions.get_mut(&thread.key) {
                    session.tail.sent = self.now;
                }
            }
        }
    }

    /// streamed text moved `key`'s tail: its entry goes out now if the last
    /// one went out long enough ago, and is held for the clock otherwise.
    fn streamed(&mut self, key: &str, changes: &mut Vec<Change>) {
        let due = self
            .sessions
            .get(key)
            .is_some_and(|s| self.now - s.tail.sent >= self.tail_every());
        if due {
            changes.extend(self.thread_change(key));
        } else {
            self.held.insert(key.to_owned());
        }
    }

    /// after an event: a turn it started or ended, then the entries whose
    /// needs or mark moved, then the order when anything that ranks moved.
    fn after_event(
        &mut self,
        moved_before: usize,
        status_before: Option<(String, Option<Activity>)>,
        changes: &mut Vec<Change>,
    ) {
        if let Some((key, before)) = status_before {
            let after = self.statuses.get(&key).map(|s| s.activity);
            self.turned(&key, before, after);
        }
        let needs_moved = self.effects[moved_before..]
            .iter()
            .any(|e| matches!(e, Effect::Need(_) | Effect::Read { .. }));
        if !self.clears.is_empty() {
            let touched: Vec<String> = changes.iter().filter_map(touched_key).collect();
            self.spend_clears(touched);
        }
        if needs_moved {
            self.refresh_touched(moved_before, changes);
        }
        if needs_moved
            || changes.iter().any(|c| {
                matches!(
                    c,
                    Change::Thread { .. }
                        | Change::ThreadRemoved { .. }
                        | Change::Ask { .. }
                        | Change::AskSettled { .. }
                )
            })
        {
            self.reorder(changes);
        }
    }

    fn stale(&self, host: &str, domain: Domain, seq: Option<u64>) -> bool {
        let Some(seq) = seq else { return false };
        let Some(floors) = self.floors.get(host) else {
            return false;
        };
        let floor = match domain {
            Domain::Sessions => floors.sessions,
            Domain::Statuses => floors.statuses,
            Domain::Permissions => floors.permissions,
            Domain::Questions => floors.questions,
        };
        seq <= floor
    }

    fn drop_host(&mut self, host: &str) {
        self.sessions.retain(|_, s| s.host != host);
        let prefix = format!("{host}:");
        self.newest.retain(|key, _| !key.starts_with(&prefix));
        self.unseen.retain(|key, _| !key.starts_with(&prefix));
        self.statuses.retain(|key, _| !key.starts_with(&prefix));
        self.held.retain(|key| !key.starts_with(&prefix));
        let gone: Vec<String> = self
            .adopted
            .iter()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        for key in gone {
            self.forget_adopted(&key);
        }
        self.asks.retain(|(h, _), _| h != host);
    }

    /// the adopted threads of `host`, out of the model quietly: the store keeps them, and
    /// `hold_adopted` puts them back once the host is read.
    fn take_adopted(&mut self, host: &str) -> Vec<(String, Session)> {
        let mine: Vec<String> = self
            .adopted
            .iter()
            .filter(|key| self.sessions.get(*key).is_some_and(|s| s.host == host))
            .cloned()
            .collect();
        self.adopted.retain(|key| !mine.contains(key));
        mine.into_iter()
            .filter_map(|key| self.sessions.remove(&key).map(|s| (key, s)))
            .collect()
    }

    /// puts the adopted threads back after `host` was read: the ones the model
    /// carried over and the ones the store kept from before the start, for
    /// this host, which come back at its first read. one the newest listing
    /// holds is ordinary again, and one archived meanwhile is gone.
    fn hold_adopted(
        &mut self,
        host: &str,
        mut carried: Vec<(String, Session)>,
        epoch_moved: bool,
        keys: &mut Vec<String>,
    ) {
        let prefix = format!("{host}:");
        let (mine, other): (Vec<_>, Vec<_>) = std::mem::take(&mut self.restored)
            .into_iter()
            .partition(|(key, _)| key.starts_with(&prefix));
        self.restored = other;
        for (key, thread) in mine {
            let Some(thread) = thread else {
                self.effects.push(Effect::Unadopted(key));
                continue;
            };
            if !thread.archived && !carried.iter().any(|(held, _)| *held == key) {
                carried.push((key, session(host, thread, Default::default())));
            } else {
                self.effects.push(Effect::Unadopted(key));
            }
        }
        for (key, mut session) in carried {
            if self.sessions.contains_key(&key) {
                self.effects.push(Effect::Unadopted(key));
                continue;
            }
            if epoch_moved || matches!(session.tail.hydration, Hydration::Failed) {
                session.tail.hydration = Hydration::Unread;
            }
            self.sessions.insert(key.clone(), session);
            self.adopted.push(key.clone());
            keys.push(key);
        }
    }

    /// an adopted thread is no longer one: the store forgets it too.
    fn forget_adopted(&mut self, key: &str) {
        if let Some(at) = self.adopted.iter().position(|k| k == key) {
            self.adopted.remove(at);
            self.effects.push(Effect::Unadopted(key.to_owned()));
        }
    }

    fn upsert_session(&mut self, host: &str, thread: ThreadFacts, changes: &mut Vec<Change>) {
        let key = session_key(host, &thread.id);
        // archiving takes a thread out of every listing (cmx2: its history stays on disk), so it leaves the fleet
        if thread.archived {
            if self.sessions.contains_key(&key) {
                self.remove_session(&key, changes);
            }
            return;
        }
        let (carried, srev) = self
            .sessions
            .remove(&key)
            .map(|s| ((s.tail, s.turn), s.srev))
            .unwrap_or_default();
        let mut session = session(host, thread, carried);
        // cmx2 moves a revision without a counted event only for writes the journal never saw (a revert armed or
        // undone, rows healed from the transcript file, a landing that failed part way): a session info past the
        // revision the journal holds says so, and the thread is read again rather than taken as unchanged
        let unseen = match (srev, session.srev) {
            (Some(held), Some(now)) if now > held => Some(now),
            _ => None,
        };
        // a compact replay keeps only each key's last update, so a session info can come ahead of the entry that
        // carried its revision's event: judged once the replay is caught up, against what its events reached
        let replaying = self.replaying.contains(host);
        session.srev = if replaying && unseen.is_some() {
            srev
        } else {
            higher(srev, session.srev)
        };
        self.sessions.insert(key.clone(), session);
        changes.extend(self.thread_change(&key));
        match unseen {
            Some(rev) if replaying => {
                let deferred = self.unseen.entry(key.clone()).or_default();
                *deferred = (*deferred).max(rev);
            }
            Some(_) => changes.push(Change::ThreadReset { key: key.clone() }),
            None => {}
        }
        self.evict(changes, Some(&key));
    }

    fn remove_session(&mut self, key: &str, changes: &mut Vec<Change>) {
        let parent = self.sessions.remove(key).and_then(|s| s.parent);
        self.statuses.remove(key);
        self.newest.remove(key);
        self.unseen.remove(key);
        self.held.remove(key);
        self.forget_adopted(key);
        self.serve_session(key, |_| true, &By::Agent, How::Gone);
        self.reads.forget(key);
        self.effects.push(Effect::ReadForgotten(key.to_owned()));
        if self.clears.remove(key) {
            self.effects.push(Effect::Uncleared(key.to_owned()));
        }
        if self.clears.unkeep(key) {
            self.effects.push(Effect::Unkept(key.to_owned()));
        }
        self.quiet.remove(key);
        let mut asks: Vec<(u64, (String, String))> = self
            .asks
            .iter()
            .filter(|(_, p)| p.neutral.key == key)
            .map(|(k, p)| (p.serial, k.clone()))
            .collect();
        asks.sort();
        for (_, (host, id)) in asks {
            self.asks.remove(&(host.clone(), id.clone()));
            changes.push(self.unknown_settle(&host, id));
        }
        changes.push(Change::ThreadRemoved {
            key: key.to_owned(),
        });
        if let Some(parent) = parent {
            changes.extend(self.thread_change(&parent));
        }
    }

    fn set_status(
        &mut self,
        host: &str,
        id: &str,
        status: Option<Status>,
        changes: &mut Vec<Change>,
    ) {
        let key = session_key(host, id);
        match status {
            Some(status) => {
                self.statuses.insert(key.clone(), status);
            }
            None => {
                if self.statuses.remove(&key).is_none() {
                    return;
                }
            }
        }
        changes.extend(self.thread_change(&key));
        // a subagent's turn starting or stopping changes its parent's count
        if let Some(parent) = self.sessions.get(&key).and_then(|s| s.parent.clone()) {
            changes.extend(self.thread_change(&parent));
        }
    }

    /// holds an ask, its source's own words and all; the ask the wire carries
    /// names the agent it waits on.
    fn add_ask(&mut self, host: &str, mut neutral: wire::Ask) -> wire::Ask {
        host.clone_into(&mut neutral.agent);
        self.serial += 1;
        self.asks.insert(
            (host.to_owned(), neutral.id.clone()),
            Pending {
                neutral: Box::new(neutral.clone()),
                serial: self.serial,
            },
        );
        neutral
    }

    fn ask_arrived(&mut self, host: &str, neutral: wire::Ask, changes: &mut Vec<Change>) {
        let words = need_words(&neutral);
        let ask = self.add_ask(host, neutral);
        self.ask_need(&ask, &words, false);
        changes.push(Change::Ask { ask });
    }

    /// an ask was settled. `settled` is the source's word on how, none when
    /// the ask went for another reason: what the wire says is then unknown.
    fn settle(
        &mut self,
        host: &str,
        id: &str,
        settled: Option<wire::AskSettled>,
        changes: &mut Vec<Change>,
    ) {
        let answering = self
            .answering
            .remove(&(host.to_owned(), id.to_owned()))
            .map(|(device, _)| device);
        let by = settled.as_ref().and_then(|s| s.by.as_ref());
        let (by, how) = match (answering, by) {
            (Some(device), _) => (
                By::Device {
                    device: device.id,
                    class: device.class,
                },
                How::Answered,
            ),
            (
                None,
                Some(wire::SettledBy {
                    kind: SettlerKind::Device | SettlerKind::Channel,
                    name: Some(who),
                    ..
                }),
            ) => (By::Elsewhere { who: who.clone() }, How::Answered),
            (None, _) => (By::Agent, How::Dropped),
        };
        let now = self.now;
        let mut moved = Vec::new();
        self.needs
            .serve(&ask_need_id(host, id), by, how, now, &mut moved);
        self.effects.extend(moved.into_iter().map(Effect::Need));
        if self
            .asks
            .remove(&(host.to_owned(), id.to_owned()))
            .is_some()
        {
            changes.push(match settled {
                Some(mut settled) => {
                    host.clone_into(&mut settled.agent);
                    id.clone_into(&mut settled.id);
                    Change::AskSettled(settled)
                }
                None => self.unknown_settle(host, id.to_owned()),
            });
        }
    }

    /// folds a part into its session's tail; true when the tail changed.
    fn retail(&mut self, key: &str, seq: Option<u64>, part: &Part) -> bool {
        let Some(session) = self.sessions.get_mut(key) else {
            return false;
        };
        if session.tail.holds(seq) {
            return false;
        }
        let Some(facts) = part_facts(part) else {
            return false;
        };
        let Some(role) = session.tail.role_of(&facts.message_id) else {
            return false;
        };
        let Some(item) = tail_item(facts, role) else {
            return false;
        };
        session.tail.record(TailOp::Put {
            seq,
            item: item.clone(),
        });
        // a part nobody could see before or after (an announced part whose text has not started,
        // thinking a window does not show) moves the tail without moving what a window renders;
        // the next entry carries it. an insert into a full tail pushes the oldest item out, which is seen
        let (seen, pushes) = session
            .tail
            .items
            .iter()
            .find(|t| t.part_id == item.part_id)
            .map_or((false, session.tail.items.len() >= TAIL_ITEMS), |held| {
                (held.shows(), false)
            });
        let shown = item.shows();
        session.tail.put(item) && (shown || seen || pushes)
    }

    /// holds the session count at `MAX_SESSIONS`. `keep` is the session that
    /// just arrived: a thread opened from history is the oldest the fleet
    /// holds, and dropping it as it came in would be the whole point lost.
    fn evict(&mut self, changes: &mut Vec<Change>, keep: Option<&str>) {
        while self.sessions.len() > MAX_SESSIONS {
            let asked: std::collections::HashSet<&str> =
                self.asks.values().map(|p| p.neutral.key.as_str()).collect();
            let victim = self
                .sessions
                .iter()
                .filter(|(key, _)| {
                    !self.statuses.contains_key(*key)
                        && !asked.contains(key.as_str())
                        && keep != Some(key.as_str())
                        // a thread a person opened from history, or has on a stage now, is not the one to drop
                        && !self.adopted.contains(*key)
                        && !self.on_a_stage(key)
                })
                // ties go by key, not by the map's order, so the same inputs evict the same session
                .min_by(|a, b| {
                    a.1.updated
                        .total_cmp(&b.1.updated)
                        .then_with(|| a.0.cmp(b.0))
                })
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else { break };
            self.remove_session(&victim, changes);
        }
    }

    /// the mark of a thread that is off home now: cleared, and nothing has
    /// happened to it since (`clears.rs`). a thread that came back has none,
    /// even in the moment before its spent mark is dropped.
    fn cleared_mark(&self, key: &str) -> Option<f64> {
        let clear = self.clears.get(key)?;
        let session = self.sessions.get(key)?;
        self.holds_clear(key, session.updated, clear)
            .then_some(clear.mark)
    }

    /// whether `clear` still holds for a thread last updated at `updated`: it
    /// has not been touched past the mark, no turn runs, and nothing asks.
    fn holds_clear(&self, key: &str, updated: f64, clear: Clear) -> bool {
        updated <= clear.mark
            && !matches!(
                self.statuses.get(key).map(|s| s.activity),
                Some(Activity::Busy { .. })
            )
            && !self.asks.values().any(|p| p.neutral.key == key)
    }

    /// recomputes the window order and appends it when it moved.
    /// the inbox order (`design.md`): wants you, oldest ask first; failed;
    /// done and news, newest first; working, the newest turn first (a
    /// thread working through its agents is working); parked on jobs
    /// alone; then the rest, most recent first.
    fn reorder(&mut self, changes: &mut Vec<Change>) {
        let mut ranked: Vec<(u8, f64, &str)> = self
            .sessions
            .iter()
            .map(|(key, s)| {
                #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
                // a job notice ranks only when the person counts it as a need (decision 95)
                let rank = match (
                    self.needs.lead_counting(key, self.home.jobs_as_needs),
                    self.statuses.get(key).map(|st| st.activity),
                ) {
                    // a cleared thread is off home: it ranks below every other, whatever need it still holds (a
                    // review waits on its merge), so it never leads the order and past the cap never pushes an
                    // uncleared thread off
                    _ if self.cleared_mark(key).is_some() => (6, -s.updated),
                    (Some((rank, at)), _) => (rank, at as f64),
                    (
                        None,
                        Some(
                            Activity::Busy { since }
                            | Activity::Parked {
                                since, agents: 1.., ..
                            },
                        ),
                    ) => (3, -since),
                    (None, Some(Activity::Parked { since, .. })) => (4, -since),
                    (None, None) => (5, -s.updated),
                };
                (rank.0, rank.1, key.as_str())
            })
            .collect();
        // the keys are unique, so this order has no ties and an unstable
        // sort gives the same answer as a stable one. past the cap only the
        // first `MAX_ORDER` matter, which selecting them first sorts less.
        let rank = |a: &(u8, f64, &str), b: &(u8, f64, &str)| {
            a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)).then(a.2.cmp(b.2))
        };
        if ranked.len() > MAX_ORDER {
            ranked.select_nth_unstable_by(MAX_ORDER, rank);
            ranked.truncate(MAX_ORDER);
        }
        ranked.sort_unstable_by(rank);
        // most ranks do not move when a thread streams: compare in place, and
        // build the keys only when the order moved
        let moved = ranked.len() != self.order.len()
            || ranked
                .iter()
                .zip(&self.order)
                .any(|(&(_, _, key), held)| key != held);
        if !moved {
            return;
        }
        let order: Vec<String> = ranked
            .into_iter()
            .map(|(_, _, key)| key.to_owned())
            .collect();
        self.order.clone_from(&order);
        changes.push(Change::Order { keys: order });
    }
}

/// how each thread of a clear went, in the order asked.
pub type ClearAnswers = Vec<(String, Result<(), ClearRefused>)>;

/// how each thread of an unclear went, in the order asked: brought back,
/// with the cause of the clear it undid (hand or auto, for telemetry), or why not.
pub type UnclearAnswers = Vec<(String, Result<Cause, UnclearRefused>)>;

/// why a thread could not be brought back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnclearRefused {
    /// the fleet does not hold it.
    NoSuchSession,
    /// it is not cleared: never was, or it came back by itself already.
    NotCleared,
}

/// what one sweep did, for its log line and its telemetry row.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    /// the home windows it looked at.
    pub windows: usize,
    /// the threads it cleared, in the window order.
    pub cleared: Vec<String>,
    /// threads it could have cleared past `MAX_SWEEP_CLEARS`, left for the next run.
    pub left: usize,
    /// no device was looking: the clears join the away summary.
    pub away: bool,
    pub mode: AutoClear,
}

/// when an eligible thread settled and was seen, for its clear mark.
#[derive(Clone, Copy, Debug)]
struct Settled {
    done_at: i64,
    seen_at: Option<i64>,
}

/// why a repo's colour could not be chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColourRefused {
    /// boxbox has given the repo no colour and holds no session of it, or its
    /// root is longer than the table holds.
    UnknownRepo,
}

/// why a thread could not be cleared off home.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClearRefused {
    /// the fleet does not hold it (deleted, archived, or older than its host's newest 300).
    NoSuchSession,
    /// a subagent has no window of its own to clear.
    Subagent,
    /// a turn is running, or the agents it waits on are: the thread would come straight back.
    Working,
    /// it waits on an answer: the thread would come straight back.
    Asking,
}

/* —— clearing threads off home, and opening threads the fleet does not hold (`clears.rs`) —— */

impl Model {
    /// clears each of `keys` off home for `device` and says how each went.
    /// a cleared thread is taken as seen (its done, job and fault needs are
    /// served: the badge must not count what the person dismissed), and its
    /// window leaves every device's home through the entry it is re-sent
    /// with. a review need stays: the worktree still waits on a merge or a
    /// discard, and that is the thread's to say.
    pub fn clear(&mut self, keys: &[String], device: &Device) -> (Vec<Change>, ClearAnswers) {
        let from = self.effects.len();
        let answers = keys
            .iter()
            .map(|key| (key.clone(), self.clear_one(key, device)))
            .collect();
        (self.settle_moves(from), answers)
    }

    fn clear_one(&mut self, key: &str, device: &Device) -> Result<(), ClearRefused> {
        let session = self.sessions.get(key).ok_or(ClearRefused::NoSuchSession)?;
        if session.parent.is_some() {
            return Err(ClearRefused::Subagent);
        }
        let (updated, newest) = (session.updated, session.turn.newest.clone());
        // a thread whose agents are at work is working, whatever the daemon calls its own turn (the window reads it so)
        if matches!(
            self.statuses.get(key).map(|s| s.activity),
            Some(Activity::Busy { .. } | Activity::Parked { agents: 1.., .. })
        ) {
            return Err(ClearRefused::Working);
        }
        if self.asks.values().any(|p| p.neutral.key == key) {
            return Err(ClearRefused::Asking);
        }
        if let Some((message, at)) = newest {
            self.seen(key, device, &message, at, "clear");
        }
        let by = By::Device {
            device: device.id.clone(),
            class: device.class.clone(),
        };
        // a done that predates this start has no newest message to be seen through (the turn was read before boxbox
        // began), so every done and fault is served directly: clearing a thread empties its badge
        self.serve_session(
            key,
            |n| matches!(n.kind, NeedKind::Fault | NeedKind::Done),
            &by,
            How::Seen,
        );
        // cleared again by hand: what the last unclear kept it from is moot
        if self.clears.unkeep(key) {
            self.effects.push(Effect::Unkept(key.to_owned()));
        }
        self.put_clear(key, Clear::hand(updated, self.now));
        Ok(())
    }

    fn put_clear(&mut self, key: &str, clear: Clear) {
        for evicted in self.clears.put(key, clear) {
            self.effects.push(Effect::Uncleared(evicted));
        }
        self.effects.push(Effect::Cleared {
            key: key.to_owned(),
            clear,
        });
    }

    /// forgets the marks of threads that did something new: the daemon's
    /// clock moved past the mark, a turn started, or an ask was raised. a
    /// thread that came back stays back, whatever it does next.
    fn spend_clears(&mut self, keys: impl IntoIterator<Item = String>) {
        for key in keys {
            let (Some(clear), Some(session)) = (self.clears.get(&key), self.sessions.get(&key))
            else {
                continue;
            };
            if !self.holds_clear(&key, session.updated, clear) {
                self.clears.remove(&key);
                self.effects.push(Effect::Uncleared(key));
            }
        }
    }

    /// which of these threads, each with the `time.updated` the daemon just
    /// listed for it, are off home now (history marks them).
    #[must_use]
    pub fn cleared_among(&self, rows: &[(String, f64)]) -> Vec<bool> {
        rows.iter()
            .map(|(key, updated)| {
                self.clears
                    .get(key)
                    .is_some_and(|clear| self.holds_clear(key, *updated, clear))
            })
            .collect()
    }

    /// a thread the fleet does not hold yet, read from its daemon because a
    /// person opened it from history. one that is held already is left as it
    /// is. it joins the fleet like any session, so the thread's stage and
    /// every device's cache know it.
    ///
    /// # Errors
    /// `info` is not a session.
    pub fn adopt_thread(&mut self, host: &str, thread: ThreadFacts) -> Vec<Change> {
        let key = session_key(host, &thread.id);
        let mut changes = Vec::new();
        if thread.archived {
            return changes;
        }
        let info = thread.raw.clone();
        // the store's copy of it is superseded by this read
        self.restored.retain(|(kept, _)| *kept != key);
        if self.sessions.contains_key(&key) {
            // opened again: it is the newest adoption, so it is the last to go, and its info is as the daemon says now
            if let Some(at) = self.adopted.iter().position(|k| *k == key) {
                let key = self.adopted.remove(at);
                self.adopted.push(key.clone());
                self.upsert_session(host, thread, &mut changes);
                if let Some(info) = info {
                    self.effects.push(Effect::Adopted { key, info });
                }
                self.reorder(&mut changes);
                self.journaled(&changes);
            }
            return changes;
        }
        self.upsert_session(host, thread, &mut changes);
        self.adopted.push(key.clone());
        if let Some(info) = info {
            self.effects.push(Effect::Adopted {
                key: key.clone(),
                info,
            });
        }
        self.shed_adopted(&key, &mut changes);
        self.reorder(&mut changes);
        self.journaled(&changes);
        changes
    }

    /// a device has `key` open on its stage now, as push last saw it.
    fn on_a_stage(&self, key: &str) -> bool {
        self.looking
            .iter()
            .any(|l| l.until >= self.now && l.thread.as_deref() == Some(key))
    }

    /// the keys of the threads adopted, held or waiting for their host's first read.
    #[must_use]
    pub fn adopted_keys(&self) -> Vec<String> {
        self.restored
            .iter()
            .map(|(key, _)| key.clone())
            .chain(self.adopted.iter().cloned())
            .collect()
    }

    /// a thread the daemon no longer lists as live (archived, or gone) is not adopted any more: it leaves the
    /// fleet if it is held, and the store forgets it either way.
    pub fn unadopt(&mut self, key: &str) -> Vec<Change> {
        let mut changes = Vec::new();
        if let Some(at) = self.restored.iter().position(|(kept, _)| kept == key) {
            self.restored.remove(at);
            self.effects.push(Effect::Unadopted(key.to_owned()));
        }
        if self.adopted.iter().any(|k| k == key) {
            self.remove_session(key, &mut changes);
            self.reorder(&mut changes);
            self.journaled(&changes);
        }
        changes
    }

    /// holds adopted threads at `MAX_ADOPTED`: the oldest goes, unless it works,
    /// asks, or is on a device's stage. `keep` is the one that just came in.
    fn shed_adopted(&mut self, keep: &str, changes: &mut Vec<Change>) {
        while self.adopted.len() > MAX_ADOPTED {
            let asked: std::collections::HashSet<&str> =
                self.asks.values().map(|p| p.neutral.key.as_str()).collect();
            let victim = self.adopted.iter().find(|key| {
                key.as_str() != keep
                    && !self.statuses.contains_key(key.as_str())
                    && !asked.contains(key.as_str())
                    && !self.on_a_stage(key)
            });
            let Some(victim) = victim.cloned() else { break };
            self.remove_session(&victim, changes);
        }
    }
}

/* —— finished work clearing itself: the sweep, unclear, the away summary (decisions 93 to 95) —— */

impl Model {
    /// the person's home prefs changed: the sweep follows the new rule from
    /// its next run, and the order re-ranks at once when job notices start or
    /// stop counting.
    pub fn set_home(&mut self, home: HomePrefs) -> Vec<Change> {
        self.home = home;
        let mut changes = Vec::new();
        self.reorder(&mut changes);
        self.journaled(&changes);
        changes
    }

    #[must_use]
    pub fn home(&self) -> HomePrefs {
        self.home
    }

    /// how long the sweep's rules wait; the defaults unless a dev config asks.
    pub fn set_pace(&mut self, pace: SweepPace) {
        self.pace = pace;
    }

    /// a device is looking at boxbox now (decision 23: visible, focused,
    /// reported in the last 90 s).
    #[must_use]
    pub fn anyone_looking(&self) -> bool {
        self.looking.iter().any(|l| l.until >= self.now)
    }

    /// clears every home window that finished and that the person's rule
    /// says may go: at most `MAX_ORDER` windows, the ones on home by the
    /// app's own membership rule, so a first sweep after an upgrade looks at
    /// what home shows and nothing older. an auto-clear is a clear like a
    /// hand one (the thread comes back the same ways), marked `auto`, with its
    /// done and job needs served so the badge drops.
    pub fn sweep(&mut self) -> (Vec<Change>, Swept) {
        let from = self.effects.len();
        self.spend_kept();
        let mode = self.home.auto_clear;
        let mut swept = Swept {
            away: !self.anyone_looking(),
            mode,
            ..Swept::default()
        };
        if mode == AutoClear::Never {
            self.quiet.clear();
            return (self.settle_moves(from), swept);
        }
        let windows = self.home_windows();
        let held: HashSet<&str> = windows.iter().map(String::as_str).collect();
        self.quiet.retain(|key, _| held.contains(key.as_str()));
        swept.windows = windows.len();
        for key in windows {
            if let Some(settled) = self.sweepable(&key, mode) {
                if swept.cleared.len() < MAX_SWEEP_CLEARS {
                    self.auto_clear(&key, settled, swept.away);
                    swept.cleared.push(key);
                } else {
                    swept.left += 1;
                }
            }
        }
        (self.settle_moves(from), swept)
    }

    /// the home windows in the window order, at most `MAX_ORDER`.
    fn home_windows(&self) -> Vec<String> {
        let asking: HashSet<&str> = self.asks.values().map(|p| p.neutral.key.as_str()).collect();
        #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
        let now = self.now as f64;
        self.order
            .iter()
            .filter(|key| {
                self.sessions.get(*key).is_some_and(|s| {
                    self.is_home_window(key, s.parent.is_some(), s.updated, now, &asking)
                })
            })
            .take(MAX_ORDER)
            .cloned()
            .collect()
    }

    /// when `key` settled and was seen, if the sweep may clear it under
    /// `mode` now. never one that is a subagent, cleared, working, retrying,
    /// parked (on agents or on jobs alone), has prompts queued, asks, failed or
    /// stopped, waits on a review, or was brought back and not updated since.
    fn sweepable(&mut self, key: &str, mode: AutoClear) -> Option<Settled> {
        let session = self.sessions.get(key)?;
        if session.parent.is_some() || self.cleared_mark(key).is_some() {
            return None;
        }
        if self.statuses.contains_key(key) {
            self.quiet.remove(key);
            return None;
        }
        let (updated, queued, reply) = (
            session.updated,
            session.thread.queued,
            session.turn.reply.as_ref().map(|r| r.created),
        );
        let now = self.now;
        // the first sweep to find it idle at this `updated` starts its quiet
        let quiet_since = match self.quiet.get(key) {
            Some(&(at_updated, since)) if at_updated.total_cmp(&updated).is_eq() => since,
            _ => {
                self.quiet.insert(key.to_owned(), (updated, now));
                now
            }
        };
        if queued > 0 || self.asks.values().any(|p| p.neutral.key == key) {
            return None;
        }
        let mut done = None;
        for need in self.needs.open_iter().filter(|n| n.key == key) {
            match need.kind {
                NeedKind::Permission | NeedKind::Question | NeedKind::Fault | NeedKind::Review => {
                    return None;
                }
                NeedKind::Done => done = done.max(Some(need.raised_at)),
                NeedKind::Job => {}
            }
        }
        if self
            .clears
            .kept(key)
            .is_some_and(|kept| updated <= kept.updated)
        {
            return None;
        }
        // seen: a person's mark covers the reply its done is about, so no done is open. not the newest
        // message: a daemon can leave the newest the model heard (a step's message it removed) out of the
        // transcript a device reads and marks, and a thread would then never count as seen
        let seen_at = self
            .reads
            .merged(key)
            .filter(|_| done.is_none() && reply.is_none_or(|at| self.reads.seen(key, at)))
            .map(|mark| mark.marked_at);
        // when it finished, for the away summary: its done, open or served lately; else when it went quiet
        let done_at = done
            .or_else(|| self.needs.last_served_raise(key, NeedKind::Done))
            .unwrap_or_else(|| seen_at.map_or(quiet_since, |s| s.min(quiet_since)));
        let due = match mode {
            AutoClear::Seen1h => seen_at.is_some_and(|seen| now - seen >= self.pace.seen_for),
            // settled: its done was raised, else its finished reply was seen, else it went quiet
            AutoClear::Any3h => {
                now - done.or(seen_at).unwrap_or(quiet_since) >= self.pace.settled_for
            }
            AutoClear::Never => false,
        };
        due.then_some(Settled { done_at, seen_at })
    }

    fn auto_clear(&mut self, key: &str, settled: Settled, away: bool) {
        let Some(updated) = self.sessions.get(key).map(|s| s.updated) else {
            return;
        };
        self.serve_session(
            key,
            |n| matches!(n.kind, NeedKind::Done | NeedKind::Job),
            &By::Agent,
            How::Cleared,
        );
        self.quiet.remove(key);
        self.put_clear(
            key,
            Clear {
                mark: updated,
                at: self.now,
                cause: Cause::Auto,
                away,
                done_at: Some(settled.done_at),
                seen_at: settled.seen_at,
                acked: false,
            },
        );
    }

    /// forgets the kept marks of threads updated since, or gone.
    fn spend_kept(&mut self) {
        let spent: Vec<String> = self
            .clears
            .kept_iter()
            .filter(|(key, kept)| {
                self.sessions
                    .get(*key)
                    .is_none_or(|s| s.updated > kept.updated)
            })
            .map(|(key, _)| key.to_owned())
            .collect();
        for key in spent {
            self.clears.unkeep(&key);
            self.effects.push(Effect::Unkept(key));
        }
    }

    /// brings each of `keys` back to home (an undo, or "bring back" from the
    /// away summary) and keeps it from the sweep until it is updated again.
    /// it returns where its order puts it.
    pub fn unclear(&mut self, keys: &[String]) -> (Vec<Change>, UnclearAnswers) {
        let from = self.effects.len();
        let answers = keys
            .iter()
            .map(|key| (key.clone(), self.unclear_one(key)))
            .collect();
        (self.settle_moves(from), answers)
    }

    fn unclear_one(&mut self, key: &str) -> Result<Cause, UnclearRefused> {
        let updated = self
            .sessions
            .get(key)
            .map(|s| s.updated)
            .ok_or(UnclearRefused::NoSuchSession)?;
        if self.cleared_mark(key).is_none() {
            return Err(UnclearRefused::NotCleared);
        }
        // the mark held (`cleared_mark`), so it is there: whose clear this undoes
        let cause = self
            .clears
            .get(key)
            .map_or(Cause::Hand, |clear| clear.cause);
        self.clears.remove(key);
        self.effects.push(Effect::Uncleared(key.to_owned()));
        let kept = Kept {
            updated,
            at: self.now,
        };
        for evicted in self.clears.keep(key, kept) {
            self.effects.push(Effect::Unkept(evicted));
        }
        self.effects.push(Effect::Kept {
            key: key.to_owned(),
            kept,
        });
        Ok(cause)
    }

    /// a person acknowledged the away summary: its rows stay cleared and
    /// leave it on every device. how many it held.
    pub fn away_seen(&mut self) -> usize {
        let held = self.away().len();
        if !self.clears.ack_away().is_empty() {
            self.effects.push(Effect::AwayAcked);
        }
        held
    }

    /// whether `key` holds an auto-clear the away summary would list: a thread
    /// arriving with one (a host read, an adoption after a start) moves the
    /// summary though no clear moved.
    #[must_use]
    pub fn has_away_clear(&self, key: &str) -> bool {
        self.clears.get(key).is_some_and(|clear| clear.in_away())
    }

    /// the away summary: auto-clears nobody was looking at, not
    /// acknowledged, whose mark still holds, newest clear first.
    #[must_use]
    pub fn away(&self) -> Vec<wire::AwayThread> {
        let mut threads: Vec<wire::AwayThread> = self
            .clears
            .iter()
            .filter(|(key, clear)| clear.in_away() && self.cleared_mark(key).is_some())
            .map(|(key, clear)| wire::AwayThread {
                key: key.to_owned(),
                done_at: clear.done_at.unwrap_or(clear.at),
                seen_at: clear.seen_at,
                cleared_at: clear.at,
            })
            .collect();
        threads.sort_by(|a, b| {
            b.cleared_at
                .cmp(&a.cleared_at)
                .then_with(|| a.key.cmp(&b.key))
        });
        threads
    }
}

/// why a mark could not be taken.
#[derive(Debug, thiserror::Error)]
pub enum ReadRefused {
    #[error("that thread is not on {} any more. it may have been archived", .0.split_once(':').map_or(.0.as_str(), |(host, _)| host))]
    NoSuchSession(String),
}

/* —— needs and read state: derived here, from the same events, once —— */

impl Model {
    /// the open needs, in inbox order.
    #[must_use]
    pub fn needs_open(&self) -> Vec<Need> {
        self.needs.open()
    }

    /// a reply from `device` went through boxbox's own send route and was taken: the person went
    /// back to the thread, so the review the agent asked for is answered by them. cmx2 says a
    /// session is busy before it says why, so the turn the reply starts cannot be relied on to
    /// show whose it was.
    pub fn review_answered(&mut self, key: &str, device: &Device) -> Vec<Change> {
        let by = By::Device {
            device: device.id.clone(),
            class: device.class.clone(),
        };
        self.serve_reviews(key, &by, How::Continued)
    }

    /// the daemon says the checkout `key`'s review is about is gone (merged or discarded where boxbox
    /// did not see it): the review has nothing left to wait on.
    pub fn review_gone(&mut self, key: &str) -> Vec<Change> {
        self.serve_reviews(key, &By::Agent, How::Settled)
    }

    fn serve_reviews(&mut self, key: &str, by: &By, how: How) -> Vec<Change> {
        let from = self.effects.len();
        self.serve_session(key, |n| n.kind == NeedKind::Review, by, how);
        self.settle_moves(from)
    }

    /// where a session works and the checkout its open review need names, for the
    /// review routes; `None` when the fleet does not hold the session.
    #[must_use]
    pub fn review_target(&self, key: &str) -> Option<ReviewTarget> {
        let session = self.sessions.get(key)?;
        let checkout = self
            .needs
            .open()
            .into_iter()
            .find(|n| n.kind == NeedKind::Review && n.key == key)
            .and_then(|n| n.checkout);
        Some(ReviewTarget {
            directory: session.directory.clone(),
            checkout,
        })
    }

    /// the needs served lately, newest first.
    #[must_use]
    pub fn needs_served(&self, limit: usize) -> Vec<Need> {
        self.needs.served(limit)
    }

    /// a send through boxbox: when the message carrying `client_id` lands
    /// in `key`, the turn it starts is armed for `device` (push: a "done"
    /// pushes only for a turn a person started).
    pub fn arm(&mut self, key: &str, client_id: &str, device: Device) {
        let now = self.now;
        self.arms.retain(|_, arm| now - arm.at <= ARM_FOR_MS);
        if self.arms.len() >= MAX_ARMS
            && let Some(oldest) = self
                .arms
                .iter()
                .min_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.0.cmp(b.0)))
                .map(|(id, _)| id.clone())
        {
            self.arms.remove(&oldest);
        }
        self.arms.insert(
            client_id.to_owned(),
            Arm {
                key: key.to_owned(),
                device,
                at: now,
            },
        );
    }

    /// an answer to `ask` is on its way from `device`: when the daemon
    /// settles it, the need is served by that device.
    pub fn answering(&mut self, host: &str, ask: &str, device: Device) {
        let now = self.now;
        self.answering
            .retain(|_, (_, at)| now - *at <= ANSWERING_FOR_MS);
        if self.answering.len() < MAX_ANSWERING {
            self.answering
                .insert((host.to_owned(), ask.to_owned()), (device, now));
        }
    }

    /// a person stopped `key`'s turn: what that turn does next is theirs.
    pub fn own_action(&mut self, key: &str) {
        let now = self.now;
        self.own.retain(|_, at| now - *at <= OWN_ACTION_MS);
        self.own.insert(key.to_owned(), now);
    }

    /// the devices looking at boxbox now; a thread on stage on one of them
    /// is seen through its newest message.
    pub fn looking(&mut self, looking: Vec<Looking>) -> Vec<Change> {
        let from = self.effects.len();
        self.looking = looking;
        let staged: Vec<(String, Device)> = self
            .looking
            .iter()
            .filter(|l| l.until >= self.now)
            .filter_map(|l| {
                let device = Device {
                    id: l.device.clone(),
                    class: l.class.clone(),
                };
                l.thread.clone().map(|key| (key, device))
            })
            .collect();
        for (key, device) in staged {
            let newest = self.sessions.get(&key).and_then(|s| s.turn.newest.clone());
            match newest {
                Some((message, at)) => self.seen(&key, &device, &message, at, "watched"),
                // no message seen since this server started (a need restored from the
                // store): on stage is seen all the same, though there is nothing to mark
                None if self.sessions.contains_key(&key) => {
                    let by = By::Device {
                        device: device.id.clone(),
                        class: device.class.clone(),
                    };
                    let news = |n: &Need| matches!(n.kind, NeedKind::Done | NeedKind::Job);
                    self.serve_session(&key, news, &by, How::Seen);
                }
                None => {}
            }
        }
        self.settle_moves(from)
    }

    /// `device` has seen `key` through `message`, created at `at` on the
    /// daemon's clock (`design.md`, unread from here).
    ///
    /// # Errors
    /// the session is not in the fleet.
    pub fn read(
        &mut self,
        key: &str,
        device: &Device,
        message: &str,
        at: f64,
    ) -> Result<Vec<Change>, ReadRefused> {
        if !self.sessions.contains_key(key) {
            return Err(ReadRefused::NoSuchSession(key.to_owned()));
        }
        let from = self.effects.len();
        self.seen(key, device, message, at, "thread");
        Ok(self.settle_moves(from))
    }

    fn seen(&mut self, key: &str, device: &Device, message: &str, at: f64, source: &'static str) {
        let mark = Mark {
            device: device.id.clone(),
            at,
            message: message.to_owned(),
            marked_at: self.now,
        };
        if let Some(mark) = self.reads.mark(key, mark) {
            self.effects.push(Effect::Read {
                key: key.to_owned(),
                mark,
                source,
            });
        }
        let Some(turn) = self.sessions.get(key).map(|s| s.turn.clone()) else {
            return;
        };
        // a reply or message this server never saw (a need restored from the store) is
        // taken as seen: the device is showing the thread as it stands
        let reply_seen = turn
            .reply
            .as_ref()
            .is_none_or(|r| self.reads.seen(key, r.created));
        let newest_seen = turn
            .newest
            .as_ref()
            .is_none_or(|(_, at)| self.reads.seen(key, *at));
        let by = By::Device {
            device: device.id.clone(),
            class: device.class.clone(),
        };
        self.serve_session(
            key,
            |n| {
                (n.kind == NeedKind::Done && reply_seen) || (n.kind == NeedKind::Job && newest_seen)
            },
            &by,
            How::Seen,
        );
    }

    /// the change set after needs or marks moved outside an event.
    fn settle_moves(&mut self, from: usize) -> Vec<Change> {
        let mut changes = Vec::new();
        if self.effects.len() > from {
            self.refresh_touched(from, &mut changes);
            self.reorder(&mut changes);
        }
        self.journaled(&changes);
        changes
    }

    /// replaces any thread in `changes` whose needs or mark moved
    /// since effect `from` with a fresh one, so each goes out once, current.
    fn refresh_touched(&mut self, from: usize, changes: &mut Vec<Change>) {
        let touched: BTreeSet<String> = self.effects[from..]
            .iter()
            .filter_map(|e| match e {
                Effect::Need(Moved::Raised(n) | Moved::Served(n)) => Some(n.key.clone()),
                Effect::Read { key, .. } | Effect::Cleared { key, .. } | Effect::Uncleared(key) => {
                    Some(key.clone())
                }
                _ => None,
            })
            .collect();
        changes
            .retain(|c| !matches!(c, Change::Thread { thread } if touched.contains(&thread.key)));
        for key in &touched {
            changes.extend(self.thread_change(key));
        }
    }

    /// a message's facts: the newest message, a send landing, a reply
    /// completing, a turn cut off.
    fn message(&mut self, key: &str, facts: &MessageFacts) {
        let arm = facts.client_id.as_ref().and_then(|id| self.arms.remove(id));
        let now = self.now;
        let Some(session) = self.sessions.get_mut(key) else {
            return;
        };
        if facts.queued {
            // a provisional message behind the running turn; it reissues when it lands
            if let Some(arm) = arm {
                self.arms
                    .insert(facts.client_id.clone().unwrap_or_default(), arm);
            }
            return;
        }
        if session
            .turn
            .newest
            .as_ref()
            .is_none_or(|(_, at)| facts.time.created >= *at)
        {
            session.turn.newest = Some((facts.id.clone(), facts.time.created));
        }
        if facts.role == "user" {
            if let Some(arm) = arm.filter(|a| a.key == key) {
                session.turn.sent = Some(arm.device.clone());
                session.turn.armed = Some(arm.device);
            }
            return;
        }
        if facts.role != "assistant" || facts.time.completed.is_none() {
            return;
        }
        session.turn.reply = Some(Reply {
            id: facts.id.clone(),
            created: facts.time.created,
            finish: facts.finish.clone(),
        });
        if facts.finish.as_deref() != Some("aborted")
            || session.turn.judged.as_deref() == Some(&facts.id)
        {
            return;
        }
        // a turn cut off: stopped by the person, or it died without them
        session.turn.judged = Some(facts.id.clone());
        session.turn.armed = None;
        let root = session.parent.is_none();
        let own = self
            .own
            .get(key)
            .is_some_and(|at| now - *at <= OWN_ACTION_MS);
        if root {
            let fault = FaultFacts {
                id: facts.id.clone(),
                reason: "the turn was cut off before it finished".into(),
            };
            if own {
                self.notice_only(
                    key,
                    &format!("fault:{key}:{}", fault.id),
                    About::Fault,
                    own_origin(),
                );
            } else {
                self.fault(key, &fault);
            }
        }
    }

    /// a status moved: a turn started or ended.
    fn turned(&mut self, key: &str, before: Option<Activity>, after: Option<Activity>) {
        let busy = |a: Option<Activity>| matches!(a, Some(Activity::Busy { .. }));
        // a send armed for this session and not yet landed: the daemon says busy before it says why
        let waiting = self
            .arms
            .values()
            .filter(|a| a.key == key && self.now - a.at <= SEND_STARTS_WITHIN_MS)
            .max_by(|a, b| a.at.cmp(&b.at).then_with(|| a.device.id.cmp(&b.device.id)))
            .map(|a| a.device.clone());
        let Some(session) = self.sessions.get_mut(key) else {
            return;
        };
        let root = session.parent.is_none();
        if busy(before) && !busy(after) {
            // a send that landed while the turn ran belonged to that turn: cmx2 turns a session busy
            // before its prompt's message lands, and a queued prompt reissues mid-run (docs/open.md)
            session.turn.sent = None;
        }
        if !busy(before) && busy(after) {
            // who started this turn: a device's send that landed for it, else the agent itself.
            // `armed` cannot say: it outlives a park, so the turn an agent's child wakes would
            // read as the device's
            let by = session
                .turn
                .sent
                .take()
                .or(waiting)
                .map_or(By::Agent, |d| By::Device {
                    device: d.id,
                    class: d.class,
                });
            if !root {
                return;
            }
            // a review waits on its merge or discard. a turn the agent started itself (woken by a
            // child's report) says nothing about the checkout, so only a turn a device of ours started
            // serves it: the person went back to the thread
            let by_device = matches!(by, By::Device { .. });
            self.serve_session(
                key,
                |n| {
                    matches!(n.kind, NeedKind::Done | NeedKind::Fault)
                        || (by_device && n.kind == NeedKind::Review)
                },
                &by,
                How::Continued,
            );
            self.effects.push(Effect::Continued(key.to_owned()));
        } else if busy(before) && after.is_none() {
            self.turn_ended(key);
        }
    }

    /// a turn ended with the session plainly idle: done, judged once per reply.
    fn turn_ended(&mut self, key: &str) {
        let watcher = self.watcher(key);
        let Some(session) = self.sessions.get_mut(key) else {
            return;
        };
        let Some(reply) = session.turn.reply.clone() else {
            return;
        };
        if session.turn.judged.as_deref() == Some(&reply.id) {
            return;
        }
        session.turn.judged = Some(reply.id.clone());
        let armed = session.turn.armed.take();
        if matches!(reply.finish.as_deref(), Some("aborted" | "error")) {
            return;
        }
        let id = format!("done:{key}:{}", reply.id);
        let origin = Origin {
            armed: armed.is_some(),
            subagent: session.parent.is_some(),
            ..Origin::default()
        };
        let title = format!("{} is done", session.repo);
        let body = session
            .tail
            .items
            .iter()
            .rev()
            .find(|t| t.kind == TailKind::Text && t.message_id == reply.id)
            .map_or_else(
                || "the turn finished.".to_owned(),
                |t| last_sentences(&t.text, 2),
            );
        let newest = session.turn.newest.clone();
        if origin.subagent {
            // a subagent's work flows to its parent; it never nags on its own
            self.notice_only(key, &id, About::Done, origin);
            return;
        }
        if let Some(device) = watcher {
            // watched as it settled: no unread, no need (in v1's logs most unreads were this)
            if let Some((message, at)) = newest {
                self.seen(key, &device, &message, at, "watched");
            }
            self.notice_only(key, &id, About::Done, origin);
            return;
        }
        let need = Need::new(id, NeedKind::Done, key, self.now, title, &body);
        self.raise(need, Some((About::Done, origin)));
    }

    fn fault(&mut self, key: &str, fault: &FaultFacts) {
        let Some(session) = self.sessions.get(key) else {
            return;
        };
        if session.parent.is_some() {
            // a subagent's failure is reported to its parent, which carries on
            return;
        }
        let id = format!("fault:{key}:{}", fault.id);
        if self
            .own
            .get(key)
            .is_some_and(|at| self.now - *at <= OWN_ACTION_MS)
        {
            self.notice_only(key, &id, About::Fault, own_origin());
            return;
        }
        let title = format!("{} stopped", session.repo);
        let need = Need::new(id, NeedKind::Fault, key, self.now, title, &fault.reason);
        self.raise(need, Some((About::Fault, Origin::default())));
    }

    /// a request for review: each one is its own need (`request` is the event's seq, or the time
    /// when it carried none), so an agent sent back with notes that asks again raises a card with
    /// the new note, and a replayed event is the same need and raises nothing. an earlier request
    /// for the same checkout still open is answered by the new one.
    fn review(&mut self, key: &str, checkout: &str, words: &str, request: &str) {
        let Some(session) = self.sessions.get(key) else {
            return;
        };
        let id = format!("review:{key}:{checkout}:{request}");
        let title = format!("{} is ready to merge", session.repo);
        let mut need = Need::new(id.clone(), NeedKind::Review, key, self.now, title, words);
        need.checkout = Some(checkout.to_owned());
        if self.raise(need, Some((About::Ready, Origin::default()))) {
            self.serve_session(
                key,
                |n| {
                    n.kind == NeedKind::Review
                        && n.checkout.as_deref() == Some(checkout)
                        && n.id != id
                },
                &By::Agent,
                How::Continued,
            );
        }
    }

    /// a checkout was merged or discarded: the reviews of the sessions that work in it are settled.
    /// the frame names the checkout's directory, and a session is in it when its own directory is
    /// that one or inside it, so two repos with a checkout of the same name never settle each
    /// other's. a frame with no directory settles nothing: the review's card finds the checkout
    /// gone when it reads it, and `review_gone` serves it then.
    fn review_settled(&mut self, host: &str, checkout: &str, directory: Option<&str>) {
        let Some(directory) = directory else {
            return;
        };
        let prefix = format!("{host}:");
        let keys: BTreeSet<String> = self
            .needs
            .open()
            .into_iter()
            .filter(|n| {
                n.kind == NeedKind::Review
                    && n.checkout.as_deref() == Some(checkout)
                    && n.key.starts_with(&prefix)
                    && self
                        .sessions
                        .get(&n.key)
                        .is_some_and(|s| is_inside(&s.directory, directory))
            })
            .map(|n| n.key)
            .collect();
        for key in keys {
            self.serve_session(
                &key,
                |n| n.kind == NeedKind::Review && n.checkout.as_deref() == Some(checkout),
                &By::Agent,
                How::Settled,
            );
        }
    }

    fn job(&mut self, key: &str, words: &JobWords) {
        let Some(session) = self.sessions.get(key) else {
            return;
        };
        if session.parent.is_some() {
            return;
        }
        let title = format!("{}: {}", session.repo, words.what);
        let need = Need::new(
            format!("job:{key}:{}", words.id),
            NeedKind::Job,
            key,
            self.now,
            title,
            &words.detail,
        );
        // a job notice wakes the agent; it is news in the inbox, not a push (design.md, attention)
        self.raise(need, None);
    }

    /// an ask's need. `reread`: the ask came back in a host read; one
    /// already raised is judged again as replayed, so the push funnel says
    /// so, and never buzzes twice.
    fn ask_need(&mut self, ask: &wire::Ask, body: &str, reread: bool) {
        let id = ask_need_id(&ask.agent, &ask.id);
        let (kind, push_kind) = match ask.kind {
            wire::AskKind::Permission => (NeedKind::Permission, PushAsk::Permission),
            wire::AskKind::Question => (NeedKind::Question, PushAsk::Question),
        };
        let about = About::Ask {
            id: ask.id.clone(),
            kind: push_kind,
        };
        if self.needs.is_known(&id) {
            if reread {
                let origin = Origin {
                    replayed: true,
                    ..Origin::default()
                };
                self.notice_only(&ask.key, &id, about, origin);
            }
            return;
        }
        let repo = self
            .sessions
            .get(&ask.key)
            .map_or(ask.agent.as_str(), |s| s.repo.as_str());
        let title = format!("{repo} wants you");
        let mut need = Need::new(id, kind, &ask.key, self.now, title, body);
        need.ask = Some(ask.id.clone());
        self.raise(need, Some((about, Origin::default())));
    }

    /// after a host read: its asks raise (or replay) their needs, and what
    /// the read no longer holds is served.
    fn reread_needs(&mut self, host: &str) {
        let mut asks: Vec<&Pending> = self
            .asks
            .iter()
            .filter(|((h, _), _)| h == host)
            .map(|(_, p)| p)
            .collect();
        asks.sort_by_key(|p| p.serial);
        let asks: Vec<(wire::Ask, String)> = asks
            .into_iter()
            .map(|p| ((*p.neutral).clone(), need_words(&p.neutral)))
            .collect();
        for (ask, words) in &asks {
            self.ask_need(ask, words, true);
        }
        let prefix = format!("{host}:");
        let stale: Vec<(String, bool)> = self
            .needs
            .open()
            .into_iter()
            .filter(|n| n.key.starts_with(&prefix))
            .filter_map(|n| {
                let gone = !self.sessions.contains_key(&n.key);
                let settled = n.kind.is_ask()
                    && n.ask
                        .as_ref()
                        .is_some_and(|a| !self.asks.contains_key(&(host.to_owned(), a.clone())));
                (gone || settled).then_some((n.id, gone))
            })
            .collect();
        let now = self.now;
        for (id, gone) in stale {
            let how = if gone { How::Gone } else { How::Dropped };
            let mut moved = Vec::new();
            self.needs.serve(&id, By::Agent, how, now, &mut moved);
            self.effects.extend(moved.into_iter().map(Effect::Need));
        }
    }

    fn serve_session(&mut self, key: &str, pick: impl Fn(&Need) -> bool, by: &By, how: How) {
        let mut moved = Vec::new();
        self.needs
            .serve_where(key, pick, by, how, self.now, &mut moved);
        self.effects.extend(moved.into_iter().map(Effect::Need));
    }

    /// raises `need` and, when it can buzz a pocket, hands push its notice.
    /// whether it was new (an id already open or served raises nothing).
    fn raise(&mut self, need: Need, notice: Option<(About, Origin)>) -> bool {
        let (key, id, title, body) = (
            need.key.clone(),
            need.id.clone(),
            need.title.clone(),
            need.body.clone(),
        );
        let mut moved = Vec::new();
        if !self.needs.raise(need, &mut moved) {
            return false;
        }
        self.effects.extend(moved.into_iter().map(Effect::Need));
        if let Some((about, origin)) = notice {
            self.notice(&key, id, about, origin, title, body);
        }
        true
    }

    /// a notice with no need behind it: push judges it and writes its
    /// `push.decided` row (own action, subagent, replayed, watched).
    fn notice_only(&mut self, key: &str, id: &str, about: About, origin: Origin) {
        let repo = self
            .sessions
            .get(key)
            .map_or("", |s| s.repo.as_str())
            .to_owned();
        let title = match about {
            About::Ask { .. } => format!("{repo} wants you"),
            About::Done => format!("{repo} is done"),
            About::Fault => format!("{repo} stopped"),
            About::Ready => format!("{repo} is ready to merge"),
        };
        let body = self
            .needs
            .get(id)
            .map(|n| n.body.clone())
            .unwrap_or_default();
        self.notice(key, id.to_owned(), about, origin, title, body);
    }

    fn notice(
        &mut self,
        key: &str,
        id: String,
        about: About,
        origin: Origin,
        title: String,
        body: String,
    ) {
        let Some(thread) = Thread::parse(key) else {
            warn!(
                key,
                id, "a need's session key is not host:session; push cannot name its thread"
            );
            return;
        };
        let badge =
            u32::try_from(self.needs.waiting_counting(self.home.jobs_as_needs)).unwrap_or(u32::MAX);
        self.effects.push(Effect::Notice(Notice {
            id,
            about,
            thread,
            title,
            body,
            origin,
            badge: Some(badge),
        }));
    }

    /// a device looking at `key` on stage now, if any.
    fn watcher(&self, key: &str) -> Option<Device> {
        self.looking
            .iter()
            .find(|l| l.until >= self.now && l.thread.as_deref() == Some(key))
            .map(|l| Device {
                id: l.device.clone(),
                class: l.class.clone(),
            })
    }
}

/// whether `path` is `root` or a path inside it, by whole segments.
fn is_inside(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path.strip_prefix(root)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn own_origin() -> Origin {
    Origin {
        own_action: true,
        ..Origin::default()
    }
}

/// the higher of two transcript revisions, either one when only it is known.
fn higher(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, None) => a,
        (None, b) => b,
    }
}

/// the thread a change shows, for the clears and the tail reads.
fn touched_key(change: &Change) -> Option<String> {
    match change {
        Change::Thread { thread } => Some(thread.key.clone()),
        Change::Ask { ask } => Some(ask.key.clone()),
        _ => None,
    }
}

fn session(host: &str, mut thread: ThreadFacts, (tail, turn): (Tail, Turn)) -> Session {
    // only an adoption persists the source's raw info, and it has it already
    thread.raw = None;
    let (repo, directory, places) = match &thread.place {
        Some(place) => (
            place.name.clone(),
            place.directory.clone(),
            [place.root.clone(), place.directory.clone()],
        ),
        None => (thread.title.clone(), String::new(), Default::default()),
    };
    Session {
        host: host.to_owned(),
        id: thread.id.clone(),
        updated: thread.updated,
        parent: thread.parent.as_deref().map(|p| session_key(host, p)),
        directory,
        repo,
        places,
        srev: thread.rev,
        thread,
        tail,
        turn,
    }
}

/// an ask's need body: what the agent wants to do, the question it asks,
/// or that it waits.
fn need_words(ask: &wire::Ask) -> String {
    match (
        &ask.permission,
        ask.questions.as_ref().and_then(|q| q.first()),
    ) {
        (Some(permission), _) => permission_words(&permission.title, &permission.patterns),
        (None, Some(question)) => question.question.clone(),
        (None, None) => "the agent is waiting for you".to_owned(),
    }
}

fn ask_need_id(host: &str, ask: &str) -> String {
    format!("ask:{host}:{ask}")
}

/// a process notice's reason, as a need's title says it.
fn job_verb(reason: &str) -> &'static str {
    match reason {
        "exit" => "exited",
        "port" => "opened a port",
        _ => "printed what it watched for",
    }
}

/// a permission's body: what the agent wants to do, in plain words.
fn permission_words(permission: &str, patterns: &[String]) -> String {
    let what = patterns.join(", ");
    match permission {
        "shell" | "bash" => format!("run {what}"),
        "edit" | "write" => format!("edit {what}"),
        "read" => format!("read {what}"),
        "webfetch" => format!("fetch {what}"),
        "external_directory" => format!("reach outside the project: {what}"),
        other if what.is_empty() => format!("use {other}"),
        other => format!("{other} {what}"),
    }
}

struct FaultFacts {
    id: String,
    reason: String,
}

struct JobWords {
    id: String,
    what: String,
    detail: String,
}

/// what an activity means for the window: `None` is plain idle. a retry
/// ranks and turns as busy; a failed run is idle here.
fn activity(activity: &wire::Activity) -> Option<Activity> {
    match activity {
        wire::Activity::Busy { since } | wire::Activity::Retry { since, .. } => {
            Some(Activity::Busy {
                since: since.unwrap_or(0.0),
            })
        }
        wire::Activity::Parked {
            agents,
            jobs,
            since,
        } => Some(Activity::Parked {
            since: since.unwrap_or(0.0),
            jobs: *jobs,
            agents: *agents,
        }),
        wire::Activity::Idle | wire::Activity::Failed { .. } => None,
    }
}

impl TailRole {
    fn of(role: &str) -> Self {
        if role == "user" {
            Self::User
        } else {
            Self::Assistant
        }
    }
}

impl Tail {
    /// whether a transcript event at `seq` is in the daemon's read this tail
    /// holds already (an unsequenced one never is).
    fn holds(&self, seq: Option<u64>) -> bool {
        matches!((&self.hydration, seq), (Hydration::Read { floor }, Some(seq)) if seq <= *floor)
    }

    /// keeps a change made while the read is out, to replay on top of it. a
    /// message's or a part's later change takes its earlier one's place.
    fn record(&mut self, op: TailOp) {
        let Hydration::Asked {
            since, overflowed, ..
        } = &mut self.hydration
        else {
            return;
        };
        if *overflowed {
            return;
        }
        let held = since.iter_mut().find(|held| match (&**held, &op) {
            (TailOp::Said { id: a, .. }, TailOp::Said { id: b, .. }) => a == b,
            (TailOp::Put { item: a, .. }, TailOp::Put { item: b, .. }) => a.part_id == b.part_id,
            _ => false,
        });
        match held {
            Some(held) => *held = op,
            None => since.push(op),
        }
        if since.len() > TAIL_OPS {
            *overflowed = true;
            *since = Vec::new();
        }
    }

    /// keeps a delta made while the read is out: one that continues the last
    /// op's text grows it, keeping the end of it.
    fn record_delta(&mut self, message: &str, part: &str, delta: &str, offset: u64) {
        if delta.is_empty() {
            return;
        }
        if let Hydration::Asked {
            since,
            overflowed: false,
            ..
        } = &mut self.hydration
            && let Some(TailOp::Stream {
                part: held,
                delta: text,
                offset: start,
                ..
            }) = since.last_mut()
            && held == part
            && *start + utf16_len(text) == offset
        {
            text.push_str(delta);
            let kept = last_chars(text, 2 * TAIL_TEXT);
            if kept.len() != text.len() {
                *start += utf16_len(&text[..text.len() - kept.len()]);
                *text = kept;
            }
            return;
        }
        let kept = last_chars(delta, 2 * TAIL_TEXT);
        let skipped = utf16_len(delta) - utf16_len(&kept);
        self.record(TailOp::Stream {
            message: message.to_owned(),
            part: part.to_owned(),
            delta: kept,
            offset: offset + skipped,
        });
    }

    /// one change kept while the read was out, applied to the read when the
    /// read did not have it: sequenced ones past `floor`, deltas by offset.
    fn replay(&mut self, op: TailOp, floor: u64) {
        let newer = |seq: Option<u64>| seq.is_none_or(|seq| seq > floor);
        match op {
            TailOp::Said {
                seq,
                id,
                role,
                queued,
            } if newer(seq) => {
                self.said_as(&id, role, queued);
            }
            TailOp::Put { seq, mut item } if newer(seq) => {
                // the read may know the message better than the live stream did
                if let Some(role) = self.role_of(&item.message_id) {
                    item.role = role;
                    self.put(item);
                }
            }
            TailOp::Stream {
                message,
                part,
                delta,
                offset,
            } => {
                self.stream(&message, &part, &delta, offset);
            }
            TailOp::Removed { seq, message } if newer(seq) => {
                self.items.retain(|t| t.message_id != message);
            }
            _ => {}
        }
    }

    /// where a part of `message` goes: the side of whoever wrote it, or
    /// nowhere while it is a prompt still queued. a message this server has
    /// not seen is the agent's: every daemon path sends a message before its
    /// parts, except the resend of a reply still streaming after a resume.
    fn role_of(&self, message: &str) -> Option<TailRole> {
        match self.said.iter().rev().find(|s| s.id == message) {
            Some(said) if said.queued => None,
            Some(said) => Some(said.role),
            None => Some(TailRole::Assistant),
        }
    }

    /// remembers who wrote a message; true when that moved a part already
    /// in the tail (it came before its message, or its prompt was queued).
    fn said(&mut self, facts: &MessageFacts) -> bool {
        self.said_as(&facts.id, TailRole::of(facts.role), facts.queued)
    }

    fn said_as(&mut self, id: &str, role: TailRole, queued: bool) -> bool {
        if let Some(said) = self.said.iter_mut().find(|s| s.id == id) {
            said.role = role;
            said.queued = queued;
        } else {
            self.said.push_back(Said {
                id: id.to_owned(),
                role,
                queued,
            });
            if self.said.len() > SAID {
                self.said.pop_front();
            }
        }
        let before = self.items.len();
        if queued {
            self.items.retain(|t| t.message_id != id);
        }
        let mut moved = self.items.len() != before;
        for item in self.items.iter_mut().filter(|t| t.message_id == id) {
            if item.role != role {
                item.role = role;
                moved = true;
            }
        }
        moved
    }

    /// puts a part in place of the one with its id, or at the end; true when
    /// the tail changed.
    fn put(&mut self, item: TailItem) -> bool {
        match self.items.iter_mut().find(|t| t.part_id == item.part_id) {
            Some(held) if *held == item => false,
            Some(held) => {
                *held = item;
                true
            }
            None => {
                self.items.push(item);
                if self.items.len() > TAIL_ITEMS {
                    self.items.remove(0);
                }
                true
            }
        }
    }

    /// grows the agent's text by a streamed delta landing at `offset` (utf-16
    /// units); true when the tail changed. a delta that overlaps what the part
    /// holds adds only what is new; one past it (deltas this server missed)
    /// changes nothing until the part arrives whole.
    fn stream(&mut self, message: &str, part: &str, delta: &str, offset: u64) -> bool {
        if delta.is_empty() {
            return false;
        }
        if let Some(item) = self.items.iter_mut().find(|t| t.part_id == part) {
            let prose = matches!(item.kind, TailKind::Text | TailKind::Reasoning)
                && item.role == TailRole::Assistant;
            if !prose || offset > item.streamed {
                return false;
            }
            let fresh = after_units(delta, item.streamed - offset);
            if fresh.is_empty() {
                return false;
            }
            let mut text = std::mem::take(&mut item.text);
            text.push_str(fresh);
            item.text = last_chars(&text, TAIL_TEXT);
            item.streamed += utf16_len(fresh);
            // thinking grows the item (a window that wants to know the agent is thinking reads it) but
            // renders nothing, so it is not worth an entry a beat
            return item.shows();
        }
        if offset != 0 {
            return false;
        }
        let Some(role) = self.role_of(message) else {
            return false;
        };
        self.put(TailItem {
            part_id: part.to_owned(),
            message_id: message.to_owned(),
            kind: TailKind::Text,
            role,
            tool: None,
            state: None,
            text: last_chars(delta, TAIL_TEXT),
            streamed: utf16_len(delta),
            from: None,
        })
    }
}

fn tail_item(part: PartFacts<'_>, role: TailRole) -> Option<TailItem> {
    if part.synthetic {
        return None;
    }
    let kind = match part.kind.as_str() {
        "text" => TailKind::Text,
        "reasoning" => TailKind::Reasoning,
        "tool" => TailKind::Tool,
        "file" => TailKind::File,
        // step markers, snapshots and the like are not something a window shows
        _ => return None,
    };
    let text = match kind {
        TailKind::Text | TailKind::Reasoning => part.text.map(Cow::into_owned).unwrap_or_default(),
        TailKind::Tool => part
            .state
            .as_ref()
            .and_then(|s| s.title.clone())
            .unwrap_or_default(),
        TailKind::File | TailKind::Image | TailKind::Audio => part.filename.unwrap_or_default(),
    };
    let streamed = utf16_len(&text);
    let text = match role {
        TailRole::User => first_chars(&text, TAIL_TEXT),
        TailRole::Assistant => last_chars(&text, TAIL_TEXT),
    };
    Some(TailItem {
        part_id: part.id,
        message_id: part.message_id,
        kind,
        role,
        tool: part.tool,
        state: part.state.and_then(|s| s.status),
        text,
        streamed,
        from: part.mail.as_ref().and_then(MailFacts::agent),
    })
}

fn utf16_len(text: &str) -> u64 {
    u64::try_from(text.encode_utf16().count()).unwrap_or(u64::MAX)
}

/// `text` after its first `units` utf-16 units, cut at a character boundary.
fn after_units(text: &str, units: u64) -> &str {
    let mut seen = 0;
    for (at, c) in text.char_indices() {
        if seen >= units {
            return &text[at..];
        }
        seen += u64::try_from(c.len_utf16()).unwrap_or(2);
    }
    ""
}

fn first_chars(text: &str, count: usize) -> String {
    text.char_indices()
        .nth(count)
        .map_or_else(|| text.to_owned(), |(at, _)| text[..at].to_owned())
}

fn last_chars(text: &str, count: usize) -> String {
    let start = text
        .char_indices()
        .rev()
        .nth(count.saturating_sub(1))
        .map_or(0, |(at, _)| at);
    if text.chars().count() <= count {
        text.to_owned()
    } else {
        text[start..].to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmx2::decode_frame;
    use crate::journal::Cursor;
    use crate::source::Stamp;
    use crate::source::cmx2::translate;
    use crate::upstream::reconcile::{HostRead, Stamped};
    use crate::upstream::{Connection, FrameCounts};

    /// the reducer's tests are written as cmx2's frames and reads: each
    /// goes through the cmx2 source's translation, as it does live.
    trait ThroughCmx2 {
        fn host_read(&mut self, read: HostRead) -> Vec<Change>;
        fn tail_read(&mut self, read: (String, Cursor, String)) -> Vec<Change>;
        fn adopt(&mut self, host: &str, info: &RawValue) -> Result<Vec<Change>, serde_json::Error>;
        fn restore(
            needs: Needs,
            reads: Reads,
            clears: Clears,
            adopted: Vec<(String, Box<RawValue>)>,
        ) -> Self;
    }

    impl ThroughCmx2 for Model {
        fn host_read(&mut self, read: HostRead) -> Vec<Change> {
            let host = read.host.clone();
            self.agent_read(&host, translate::snapshot(read))
        }

        fn tail_read(&mut self, (key, cursor, body): (String, Cursor, String)) -> Vec<Change> {
            let (host, thread) = key.split_once(':').unwrap();
            let stamp = Stamp {
                epoch: cursor.epoch,
                seq: cursor.seq,
            };
            let read = translate::tail(thread.to_owned(), stamp, None, body.as_bytes()).unwrap();
            self.tail(host, read)
        }

        fn adopt(&mut self, host: &str, info: &RawValue) -> Result<Vec<Change>, serde_json::Error> {
            let thread = translate::thread_from_json(info.to_owned())?;
            Ok(self.adopt_thread(host, thread))
        }

        fn restore(
            needs: Needs,
            reads: Reads,
            clears: Clears,
            adopted: Vec<(String, Box<RawValue>)>,
        ) -> Self {
            let adopted = adopted
                .into_iter()
                .map(|(key, info)| (key, translate::thread_from_json(info).ok()))
                .collect();
            Self::restored(needs, reads, clears, adopted, Colours::default())
        }
    }

    impl Model {
        /// the thread as the stream carries it, under the name the tests
        /// knew it by.
        fn entry(&self, key: &str) -> Option<wire::Thread> {
            self.thread(key)
        }
    }

    /// one decoded frame, through the translation, into the reducer.
    fn through(model: &mut Model, seq: Option<u64>, frame: &str) -> Vec<Change> {
        let decoded = decode_frame(frame).unwrap();
        let Some(event) = translate::event(
            "desk",
            decoded.directory.as_deref(),
            &decoded.event,
            &decoded.payload,
        )
        .unwrap() else {
            return Vec::new();
        };
        model.source("desk", seq, event)
    }

    /// a session info with its transcript revision, as a daemon that numbers them sends it.
    fn info_rev(id: &str, updated: u64, rev: u64) -> String {
        let info = info(id, updated, None);
        format!("{},\"transcriptRev\":{rev}}}", &info[..info.len() - 1])
    }

    fn info(id: &str, updated: u64, parent: Option<&str>) -> String {
        let parent = parent.map_or(String::new(), |p| format!(r#""parentID":"{p}","#));
        format!(
            r#"{{"id":"{id}",{parent}"slug":"s","projectID":"/w","directory":"/w","title":"t {id}","version":"0","source":"cmx2","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":{{"created":1,"updated":{updated}}}}}"#
        )
    }

    fn event(model: &mut Model, seq: Option<u64>, payload: &str) -> Vec<Change> {
        through(model, seq, &format!(r#"{{"payload":{payload}}}"#))
    }

    /// an event the daemon framed with a directory, as it does a worktree's.
    fn event_in(
        model: &mut Model,
        seq: Option<u64>,
        directory: &str,
        payload: &str,
    ) -> Vec<Change> {
        through(
            model,
            seq,
            &format!(r#"{{"directory":"{directory}","payload":{payload}}}"#),
        )
    }

    /// a session event for a thread working in `directory`.
    fn updated_in(id: &str, at: u64, directory: &str) -> String {
        updated(id, at, None).replace(
            r#""directory":"/w""#,
            &format!(r#""directory":"{directory}""#),
        )
    }

    fn updated(id: &str, updated: u64, parent: Option<&str>) -> String {
        format!(
            r#"{{"id":"e","type":"session.updated","properties":{{"sessionID":"{id}","info":{}}}}}"#,
            info(id, updated, parent)
        )
    }

    fn status(id: &str, status: &str) -> String {
        format!(
            r#"{{"id":"e","type":"session.status","properties":{{"sessionID":"{id}","status":{status}}}}}"#
        )
    }

    fn kinds(changes: &[Change]) -> Vec<&'static str> {
        changes.iter().map(Change::kind).collect()
    }

    /// the threads a change set carries whole.
    fn threads_of(changes: &[Change]) -> Vec<&wire::Thread> {
        changes
            .iter()
            .filter_map(|c| match c {
                Change::Thread { thread } => Some(thread),
                _ => None,
            })
            .collect()
    }

    fn order(model: &Model) -> Vec<&str> {
        model.order.iter().map(String::as_str).collect()
    }

    fn empty_read(seq: u64) -> HostRead {
        HostRead {
            host: "desk".into(),
            epoch: "ep".into(),
            sessions: Stamped { seq, data: vec![] },
            statuses: Stamped { seq, data: vec![] },
            permissions: Stamped { seq, data: vec![] },
            questions: Stamped { seq, data: vec![] },
        }
    }

    #[test]
    fn a_session_update_carries_the_threads_facts_as_the_source_translated_them() {
        let mut model = Model::new();
        let changes = event(&mut model, Some(1), &updated("ses_1", 10, None));
        assert_eq!(kinds(&changes), ["thread", "order"]);
        let Change::Thread { thread: session } = &changes[0] else {
            unreachable!()
        };
        let facts = translate::thread_from_json(raw(&info("ses_1", 10, None)).unwrap()).unwrap();
        assert_eq!(session.key, "desk:ses_1");
        assert_eq!(
            (session.agent.as_str(), session.id.as_str()),
            ("desk", "ses_1")
        );
        assert_eq!(
            (
                &session.title,
                session.created,
                session.updated,
                &session.place
            ),
            (&facts.title, facts.created, facts.updated, &facts.place)
        );
        assert_eq!(session.activity, wire::Activity::Idle);
    }

    #[test]
    fn the_prompts_waiting_behind_a_running_turn_are_the_threads_queued() {
        let mut model = Model::new();
        event(&mut model, Some(1), &updated("ses_1", 10, None));
        event(
            &mut model,
            Some(2),
            &status("ses_1", r#"{"type":"busy","since":5,"queued":2}"#),
        );
        assert_eq!(model.entry("desk:ses_1").unwrap().queued, 2);
        event(
            &mut model,
            Some(3),
            r#"{"id":"e","type":"session.idle","properties":{"sessionID":"ses_1"}}"#,
        );
        assert_eq!(model.entry("desk:ses_1").unwrap().queued, 0);
    }

    #[test]
    fn a_status_keeps_the_activity_the_source_gave_retry_and_all() {
        let mut model = Model::new();
        event(&mut model, Some(1), &updated("ses_1", 10, None));
        let changes = event(
            &mut model,
            Some(2),
            &status(
                "ses_1",
                r#"{"type":"retry","attempt":2,"message":"rate limited","next":900}"#,
            ),
        );
        let Change::Thread { thread } = &changes[0] else {
            panic!("{:?}", kinds(&changes))
        };
        assert!(
            matches!(&thread.activity, wire::Activity::Retry { attempt: 2, message, .. } if message == "rate limited"),
            "{:?}",
            thread.activity
        );
    }

    #[test]
    fn a_busy_subagent_counts_on_its_parent_and_stops_counting_when_idle() {
        let mut model = Model::new();
        event(&mut model, Some(1), &updated("ses_p", 10, None));
        event(&mut model, Some(2), &updated("ses_c", 11, Some("ses_p")));
        let changes = event(
            &mut model,
            Some(3),
            &status("ses_c", r#"{"type":"busy","since":5}"#),
        );
        let parent = changes.iter().find_map(|c| match c {
            Change::Thread { thread: session } if session.id == "ses_p" => Some(session),
            _ => None,
        });
        assert_eq!(parent.unwrap().agents, 1);
        let changes = event(
            &mut model,
            Some(4),
            r#"{"id":"e","type":"session.idle","properties":{"sessionID":"ses_c"}}"#,
        );
        let parent = changes.iter().find_map(|c| match c {
            Change::Thread { thread: session } if session.id == "ses_p" => Some(session),
            _ => None,
        });
        assert_eq!(parent.unwrap().agents, 0);
    }

    #[test]
    fn idle_does_not_clear_a_parked_status() {
        let mut model = Model::new();
        event(&mut model, Some(1), &updated("ses_1", 10, None));
        event(
            &mut model,
            Some(2),
            &status(
                "ses_1",
                r#"{"type":"idle","since":9,"parked":{"agents":0,"jobs":2}}"#,
            ),
        );
        let changes = event(
            &mut model,
            Some(3),
            r#"{"id":"e","type":"session.idle","properties":{"sessionID":"ses_1"}}"#,
        );
        assert!(changes.is_empty());
        assert_eq!(model.entry("desk:ses_1").unwrap().processes, 2);
    }

    #[test]
    fn the_order_puts_asks_first_then_busy_then_parked_then_recent() {
        let mut model = Model::new();
        for (id, at) in [
            ("ses_old", 1),
            ("ses_new", 50),
            ("ses_busy", 2),
            ("ses_parked", 3),
            ("ses_asking", 4),
        ] {
            event(&mut model, None, &updated(id, at, None));
        }
        event(
            &mut model,
            None,
            &status("ses_busy", r#"{"type":"busy","since":7}"#),
        );
        event(
            &mut model,
            None,
            &status(
                "ses_parked",
                r#"{"type":"idle","since":8,"parked":{"agents":0,"jobs":1}}"#,
            ),
        );
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"question.asked","properties":{"id":"que_1","sessionID":"ses_asking","questions":[]}}"#,
        );
        assert_eq!(
            order(&model),
            [
                "desk:ses_asking",
                "desk:ses_busy",
                "desk:ses_parked",
                "desk:ses_new",
                "desk:ses_old"
            ]
        );

        let changes = event(
            &mut model,
            None,
            r#"{"id":"e","type":"question.replied","properties":{"requestID":"que_1","sessionID":"ses_asking","answers":[]}}"#,
        );
        assert_eq!(kinds(&changes), ["ask.settled", "thread", "order"]);
        assert_eq!(order(&model)[0], "desk:ses_busy");
    }

    #[test]
    fn a_thread_working_through_its_agents_ranks_with_the_busy_not_the_parked() {
        let mut model = Model::new();
        for (id, at) in [("ses_busy", 2), ("ses_agents", 3), ("ses_jobs", 4)] {
            event(&mut model, None, &updated(id, at, None));
        }
        event(
            &mut model,
            None,
            &status("ses_busy", r#"{"type":"busy","since":9}"#),
        );
        // its own turn ended earlier than the busy one began: as a working thread it is the older of the two
        event(
            &mut model,
            None,
            &status(
                "ses_agents",
                r#"{"type":"idle","since":7,"parked":{"agents":2,"jobs":0}}"#,
            ),
        );
        event(
            &mut model,
            None,
            &status(
                "ses_jobs",
                r#"{"type":"idle","since":8,"parked":{"agents":0,"jobs":1}}"#,
            ),
        );
        assert_eq!(
            order(&model),
            ["desk:ses_busy", "desk:ses_agents", "desk:ses_jobs"]
        );
    }

    #[test]
    fn an_event_already_in_a_read_does_not_turn_the_model_back() {
        let mut model = Model::new();
        let mut read = empty_read(20);
        read.sessions
            .data
            .push(raw(&info("ses_1", 10, None)).unwrap());
        let changes = model.host_read(read);
        assert_eq!(kinds(&changes), ["thread", "order"]);
        // the read at 20 shows ses_1 idle; a busy status from seq 15 is older news
        assert!(
            event(
                &mut model,
                Some(15),
                &status("ses_1", r#"{"type":"busy","since":1}"#)
            )
            .is_empty()
        );
        assert!(model.entry("desk:ses_1").unwrap().activity == wire::Activity::Idle);
        // past the floor, it applies
        assert_eq!(
            kinds(&event(
                &mut model,
                Some(21),
                &status("ses_1", r#"{"type":"busy","since":1}"#)
            )),
            // one session: the order cannot move
            ["thread"]
        );
        assert!(model.entry("desk:ses_1").unwrap().activity != wire::Activity::Idle);
    }

    #[test]
    fn transcript_events_pass_through_whatever_the_floors_say() {
        let mut model = Model::new();
        model.host_read(empty_read(20));
        let part = r#"{"id":"prt_1","sessionID":"ses_1","messageID":"msg_1","type":"text","text":"hello"}"#;
        let changes = event(
            &mut model,
            Some(5),
            &format!(
                r#"{{"id":"e","type":"message.part.updated","properties":{{"sessionID":"ses_1","part":{part}}}}}"#
            ),
        );
        let [
            Change::Part {
                upstream,
                part: passed,
                ..
            },
        ] = changes.as_slice()
        else {
            panic!("{:?}", kinds(&changes))
        };
        assert_eq!(*upstream, Some(5));
        assert_eq!(*passed, translate::part(&raw(part).unwrap()));
    }

    #[test]
    fn a_read_replaces_what_the_host_had_and_keeps_tails() {
        let mut model = Model::new();
        event(&mut model, Some(1), &updated("ses_gone", 1, None));
        event(&mut model, Some(2), &updated("ses_kept", 2, None));
        event(
            &mut model,
            Some(3),
            r#"{"id":"e","type":"message.part.updated","properties":{"sessionID":"ses_kept","part":{"id":"prt_1","sessionID":"ses_kept","messageID":"msg_1","type":"text","text":"hi"}}}"#,
        );
        let mut read = empty_read(9);
        read.sessions
            .data
            .push(raw(&info("ses_kept", 2, None)).unwrap());
        read.permissions.data.push(
            raw(r#"{"id":"per_1","sessionID":"ses_kept","permission":"read","patterns":[],"metadata":{},"always":[]}"#).unwrap(),
        );
        let changes = model.host_read(read);
        // the quiet re-read: the gone thread removed, the kept one whole and
        // reset (no revision says its transcript held still), the new ask raised
        assert_eq!(
            kinds(&changes),
            ["thread.removed", "thread", "thread.reset", "ask", "order"]
        );
        let sessions = threads_of(&changes);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].tail.len(), 1, "a tail survives a read");
        let Change::Ask { ask } = &changes[3] else {
            unreachable!()
        };
        assert_eq!(ask.id, "per_1");
        assert!(model.entry("desk:ses_gone").is_none());
    }

    #[test]
    fn a_read_settles_as_unknown_the_asks_it_no_longer_lists_and_leaves_the_open_ones_alone() {
        let mut model = Model::new();
        let permission = r#"{"id":"per_1","sessionID":"ses_1","permission":"read","patterns":[],"metadata":{},"always":[]}"#;
        let mut read = empty_read(9);
        read.sessions
            .data
            .push(raw(&info("ses_1", 2, None)).unwrap());
        read.permissions.data.push(raw(permission).unwrap());
        model.host_read(read);
        let mut again = empty_read(10);
        again
            .sessions
            .data
            .push(raw(&info("ses_1", 2, None)).unwrap());
        again.permissions.data.push(raw(permission).unwrap());
        let changes = model.host_read(again);
        assert_eq!(
            kinds(&changes),
            ["thread", "thread.reset"],
            "the ask is still open"
        );
        let changes = model.host_read({
            let mut read = empty_read(11);
            read.sessions
                .data
                .push(raw(&info("ses_1", 2, None)).unwrap());
            read
        });
        let Some(Change::AskSettled(settled)) =
            changes.iter().find(|c| matches!(c, Change::AskSettled(_)))
        else {
            panic!("{:?}", kinds(&changes))
        };
        assert_eq!(
            (settled.id.as_str(), settled.outcome),
            ("per_1", wire::Outcome::Unknown)
        );
    }

    #[test]
    fn a_tail_keeps_the_last_twelve_parts_and_the_end_of_long_text() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        for n in 0..14 {
            let text = if n == 13 {
                "x".repeat(300) + "end"
            } else {
                format!("part {n}")
            };
            event(
                &mut model,
                None,
                &format!(
                    r#"{{"id":"e","type":"message.part.updated","properties":{{"sessionID":"ses_1","part":{{"id":"prt_{n}","sessionID":"ses_1","messageID":"msg_1","type":"text","text":"{text}"}}}}}}"#
                ),
            );
        }
        let tail = model.entry("desk:ses_1").unwrap().tail;
        assert_eq!(tail.len(), TAIL_ITEMS);
        assert_eq!(tail[0].part_id, "prt_2");
        let last = &tail[TAIL_ITEMS - 1].text;
        assert_eq!(last.chars().count(), TAIL_TEXT);
        assert!(last.ends_with("end"));
    }

    #[test]
    fn a_tool_part_shows_its_tool_state_and_title() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        let part = r#"{"id":"prt_t","sessionID":"ses_1","messageID":"msg_1","type":"tool","callID":"c1","tool":"shell","state":{"status":"running","input":{},"title":"wc -l notes.md","time":{"start":1}}}"#;
        let changes = event(
            &mut model,
            None,
            &format!(
                r#"{{"id":"e","type":"message.part.updated","properties":{{"sessionID":"ses_1","part":{part}}}}}"#
            ),
        );
        assert_eq!(kinds(&changes), ["part", "thread"]);
        let tail = model.entry("desk:ses_1").unwrap().tail;
        assert_eq!(
            (
                tail[0].kind,
                tail[0].tool.as_deref(),
                tail[0].state.as_deref(),
                tail[0].text.as_str()
            ),
            (
                TailKind::Tool,
                Some("shell"),
                Some("running"),
                "wc -l notes.md"
            )
        );
    }

    #[test]
    fn deleting_a_session_settles_its_asks() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"read","patterns":[],"metadata":{},"always":[]}}"#,
        );
        let changes = event(
            &mut model,
            None,
            r#"{"id":"e","type":"session.deleted","properties":{"sessionID":"ses_1"}}"#,
        );
        assert_eq!(kinds(&changes), ["ask.settled", "thread.removed", "order"]);
    }

    #[test]
    fn a_removed_host_takes_everything_it_had() {
        let mut model = Model::new();
        let joined = model.connection(translate::connection(crate::upstream::HostStatus {
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
            connects: 1,
            frames: FrameCounts::default(),
            cursor: None,
        }));
        assert_eq!(kinds(&joined), ["agent"]);
        event(&mut model, None, &updated("ses_1", 1, None));
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"read","patterns":[],"metadata":{},"always":[]}}"#,
        );
        let changes = model.host_removed("desk");
        assert_eq!(
            kinds(&changes),
            ["thread.removed", "ask.settled", "agent.removed", "order"]
        );
        let Change::AskSettled(settled) = &changes[1] else {
            unreachable!()
        };
        assert_eq!(settled.outcome, wire::Outcome::Unknown);
        let snapshot = model.snapshot();
        assert!(
            snapshot.agents.is_empty()
                && snapshot.threads.is_empty()
                && snapshot.asks.is_empty()
                && snapshot.order.is_empty()
        );
    }

    #[test]
    fn last_chars_counts_characters_not_bytes() {
        assert_eq!(last_chars("héllo", 3), "llo");
        assert_eq!(last_chars("hé", 5), "hé");
        assert_eq!(last_chars("ééé", 2), "éé");
    }

    /* —— window tails: streamed text, who wrote it, what never enters —— */

    fn message(id: &str, role: &str, rest: &str) -> String {
        format!(
            r#"{{"id":"e","type":"message.updated","properties":{{"sessionID":"ses_1","info":{{"id":"{id}","sessionID":"ses_1","role":"{role}","time":{{"created":100}}{rest}}}}}}}"#
        )
    }

    fn text_part(message: &str, part: &str, text: &str, rest: &str) -> String {
        format!(
            r#"{{"id":"e","type":"message.part.updated","properties":{{"sessionID":"ses_1","part":{{"id":"{part}","sessionID":"ses_1","messageID":"{message}","type":"text","text":"{text}"{rest}}}}}}}"#
        )
    }

    fn delta(message: &str, part: &str, text: &str, offset: usize) -> String {
        format!(
            r#"{{"id":"e","type":"message.part.delta","properties":{{"sessionID":"ses_1","messageID":"{message}","partID":"{part}","field":"text","delta":"{text}","offset":{offset}}}}}"#
        )
    }

    /// a session with an assistant reply under way, at `now`.
    fn replying(now: i64) -> Model {
        let mut model = Model::new();
        model.at(now);
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, None, &message("msg_a", "assistant", ""));
        model
    }

    fn tail(model: &Model) -> Vec<wire::TailItem> {
        model.entry("desk:ses_1").unwrap().tail
    }

    fn sessions_in(changes: &[Change]) -> usize {
        changes
            .iter()
            .filter(|c| matches!(c, Change::Thread { .. }))
            .count()
    }

    #[test]
    fn streamed_deltas_grow_the_agents_prose_before_its_part_finishes() {
        let mut model = replying(1_000);
        model.at(2_000);
        let first = event(
            &mut model,
            None,
            &delta("msg_a", "prt_a", "the limiter ", 0),
        );
        assert_eq!(
            kinds(&first),
            ["delta", "thread"],
            "the first words go out at once"
        );
        model.at(3_000);
        event(
            &mut model,
            None,
            &delta("msg_a", "prt_a", "is a token bucket.", 12),
        );
        let tail = tail(&model);
        assert_eq!(tail.len(), 1);
        assert_eq!(
            (tail[0].kind, tail[0].role, tail[0].text.as_str()),
            (
                TailKind::Text,
                TailRole::Assistant,
                "the limiter is a token bucket."
            )
        );
        // the finished part says the same: the tail does not change again
        let whole = event(
            &mut model,
            None,
            &text_part("msg_a", "prt_a", "the limiter is a token bucket.", ""),
        );
        assert_eq!(kinds(&whole), ["part"]);
    }

    #[test]
    fn a_burst_of_deltas_puts_one_entry_in_the_journal_per_beat() {
        const DELTAS: usize = 400;
        const EVERY_MS: i64 = 10;
        let mut model = replying(0);
        let start = 1_000;
        let mut offset = 0;
        let (mut deltas, mut entries, mut flushed) = (0, 0, 0);
        for n in 0..DELTAS {
            let now = start + EVERY_MS * i64::try_from(n).unwrap();
            model.at(now);
            // the actor's clock fires for whatever came due since the last event
            if model.tail_due().is_some_and(|due| due <= now) {
                let changes = model.flush_tails();
                flushed += sessions_in(&changes);
            }
            let changes = event(&mut model, None, &delta("msg_a", "prt_a", "word ", offset));
            offset += 5;
            deltas += changes
                .iter()
                .filter(|c| matches!(c, Change::Delta { .. }))
                .count();
            entries += sessions_in(&changes);
        }
        let end = start + EVERY_MS * i64::try_from(DELTAS).unwrap();
        let due = model.tail_due().expect("the last words are held");
        assert!(due <= end + TAIL_EVERY_MS);
        model.at(due);
        flushed += sessions_in(&model.flush_tails());
        assert_eq!(model.tail_due(), None, "nothing is held after the flush");
        let span = end - start;
        println!(
            "{DELTAS} deltas over {span} ms: {deltas} delta entries, {entries} session entries with a delta, {flushed} flushed by the clock, {} in all ({:.1} a second)",
            entries + flushed,
            f64::from(u32::try_from(entries + flushed).unwrap()) * 1000.0
                / f64::from(u32::try_from(span).unwrap())
        );
        assert_eq!(deltas, DELTAS, "the thread still gets every delta");
        let beats = usize::try_from(span / TAIL_EVERY_MS).unwrap() + 1;
        assert!(
            entries + flushed <= beats,
            "{} entries for {beats} beats",
            entries + flushed
        );
        assert!(entries + flushed >= beats - 1, "the tail kept moving");
        assert!(
            tail(&model)[0].text.ends_with("word word "),
            "the flushed entry holds the last words"
        );
    }

    #[test]
    fn any_other_change_to_the_session_carries_held_text_out_with_it() {
        let mut model = replying(0);
        model.at(1_000);
        event(&mut model, None, &delta("msg_a", "prt_a", "one ", 0));
        model.at(1_050);
        let held = event(&mut model, None, &delta("msg_a", "prt_a", "two", 4));
        assert_eq!(kinds(&held), ["delta"], "inside the beat it is held");
        assert_eq!(model.tail_due(), Some(1_000 + TAIL_EVERY_MS));
        model.at(1_100);
        let changes = event(
            &mut model,
            None,
            &status("ses_1", r#"{"type":"busy","since":5}"#),
        );
        let Some(Change::Thread { thread: session }) = changes.first() else {
            panic!("{:?}", kinds(&changes))
        };
        assert_eq!(session.tail[0].text, "one two");
        assert_eq!(model.tail_due(), None, "the status carried it");
    }

    #[test]
    fn a_resent_delta_adds_only_what_is_new_and_a_gap_waits_for_the_whole_part() {
        let mut model = replying(0);
        model.at(1_000);
        event(&mut model, None, &delta("msg_a", "prt_a", "héllo ", 0));
        // overlaps the six units held: only "wörld" is new
        event(&mut model, None, &delta("msg_a", "prt_a", "o wörld", 4));
        assert_eq!(tail(&model)[0].text, "héllo wörld");
        // past what the tail holds: deltas this server missed
        event(&mut model, None, &delta("msg_a", "prt_a", " again", 40));
        assert_eq!(tail(&model)[0].text, "héllo wörld");
        // a part this server never saw the start of waits too
        event(&mut model, None, &delta("msg_a", "prt_b", "middle", 30));
        assert_eq!(tail(&model).len(), 1);
        event(
            &mut model,
            None,
            &text_part("msg_a", "prt_a", "héllo wörld, the rest", ""),
        );
        event(&mut model, None, &delta("msg_a", "prt_a", " and on", 21));
        assert_eq!(tail(&model)[0].text, "héllo wörld, the rest and on");
    }

    #[test]
    fn a_tail_item_carries_who_wrote_it() {
        let mut model = replying(0);
        event(&mut model, None, &message("msg_u", "user", ""));
        event(
            &mut model,
            None,
            &text_part("msg_u", "prt_u", "add a per-customer limit", ""),
        );
        event(&mut model, None, &delta("msg_a", "prt_a", "on it", 0));
        let tail = tail(&model);
        let roles: Vec<(&str, TailRole)> =
            tail.iter().map(|t| (t.part_id.as_str(), t.role)).collect();
        assert_eq!(
            roles,
            [("prt_u", TailRole::User), ("prt_a", TailRole::Assistant)]
        );
        let json = serde_json::to_string(&tail[0]).unwrap();
        assert_eq!(
            json,
            r#"{"partID":"prt_u","messageID":"msg_u","kind":"text","role":"user","text":"add a per-customer limit"}"#,
            "the server's own bookkeeping stays off the wire"
        );
    }

    #[test]
    fn a_part_that_beat_its_message_moves_to_its_side_when_the_message_lands() {
        let mut model = replying(0);
        event(
            &mut model,
            None,
            &text_part("msg_u", "prt_u", "ship it", ""),
        );
        assert_eq!(tail(&model)[0].role, TailRole::Assistant);
        let changes = event(&mut model, None, &message("msg_u", "user", ""));
        assert_eq!(kinds(&changes), ["message", "thread"]);
        assert_eq!(tail(&model)[0].role, TailRole::User);
    }

    #[test]
    fn a_prompt_keeps_its_start_and_the_agent_keeps_its_end() {
        let mut model = replying(0);
        event(&mut model, None, &message("msg_u", "user", ""));
        let long = format!("start {}", "x".repeat(400));
        event(&mut model, None, &text_part("msg_u", "prt_u", &long, ""));
        event(
            &mut model,
            None,
            &text_part("msg_a", "prt_a", &format!("{} end", "y".repeat(400)), ""),
        );
        let tail = tail(&model);
        assert!(tail[0].text.starts_with("start ") && tail[0].text.chars().count() == TAIL_TEXT);
        assert!(tail[1].text.ends_with(" end") && tail[1].text.chars().count() == TAIL_TEXT);
    }

    #[test]
    fn the_context_the_daemon_adds_to_a_prompt_never_enters_a_tail() {
        let mut model = replying(0);
        event(&mut model, None, &message("msg_u", "user", ""));
        let changes = event(
            &mut model,
            None,
            &text_part(
                "msg_u",
                "prt_ctx",
                "<system-reminder>the turn context</system-reminder>",
                r#","synthetic":true"#,
            ),
        );
        assert_eq!(kinds(&changes), ["part"], "the thread still gets the part");
        event(&mut model, None, &text_part("msg_u", "prt_u", "fix it", ""));
        let tail = tail(&model);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].text, "fix it");
    }

    #[test]
    fn a_queued_prompt_waits_under_the_tail_and_enters_when_it_lands() {
        let mut model = replying(0);
        event(
            &mut model,
            None,
            &message("msg_q", "user", r#","queued":true"#),
        );
        event(
            &mut model,
            None,
            &text_part("msg_q", "prt_q", "then the docs", ""),
        );
        assert!(tail(&model).is_empty());
        // it lands under its transcript id
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"message.removed","properties":{"sessionID":"ses_1","messageID":"msg_q"}}"#,
        );
        event(&mut model, None, &message("msg_u", "user", ""));
        event(
            &mut model,
            None,
            &text_part("msg_u", "prt_u", "then the docs", ""),
        );
        assert_eq!(tail(&model)[0].role, TailRole::User);
    }

    #[test]
    fn streamed_parts_keep_the_twelve_item_cap() {
        let mut model = replying(0);
        for n in 0..14 {
            model.at(1_000 * (n + 1));
            event(
                &mut model,
                None,
                &delta("msg_a", &format!("prt_{n:02}"), &format!("part {n}"), 0),
            );
        }
        let tail = tail(&model);
        assert_eq!(tail.len(), TAIL_ITEMS);
        assert_eq!(tail[0].part_id, "prt_02");
        assert_eq!(tail[TAIL_ITEMS - 1].text, "part 13");
    }

    #[test]
    fn a_session_that_goes_takes_its_held_tail_with_it() {
        let mut model = replying(0);
        model.at(1_000);
        event(&mut model, None, &delta("msg_a", "prt_a", "one ", 0));
        event(&mut model, None, &delta("msg_a", "prt_a", "two", 4));
        assert!(model.tail_due().is_some());
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"session.deleted","properties":{"sessionID":"ses_1"}}"#,
        );
        assert_eq!(model.tail_due(), None);
        model.at(5_000);
        assert!(model.flush_tails().is_empty());
    }

    /* —— needs and read state —— */

    fn message_event(id: &str, session: &str, role: &str, completed: bool, rest: &str) -> String {
        let completed = if completed { r#","completed":200"# } else { "" };
        format!(
            r#"{{"id":"e","type":"message.updated","properties":{{"sessionID":"{session}","info":{{"id":"{id}","sessionID":"{session}","role":"{role}","time":{{"created":100{completed}}}{rest}}}}}}}"#
        )
    }

    fn reply(model: &mut Model, session: &str, id: &str, finish: &str) {
        event(
            model,
            None,
            &message_event(
                id,
                session,
                "assistant",
                true,
                &format!(r#","finish":"{finish}""#),
            ),
        );
    }

    fn busy(model: &mut Model, session: &str) {
        event(
            model,
            None,
            &status(session, r#"{"type":"busy","since":5}"#),
        );
    }

    fn idle(model: &mut Model, session: &str) {
        event(
            model,
            None,
            &format!(
                r#"{{"id":"e","type":"session.idle","properties":{{"sessionID":"{session}"}}}}"#
            ),
        );
    }

    fn phone() -> Device {
        Device {
            id: "phone".into(),
            class: "iphone".into(),
        }
    }

    /// the notices and the needs raised and served, as short strings (tail
    /// reads are `asked`, below).
    fn told(model: &mut Model) -> Vec<String> {
        model
            .drain()
            .into_iter()
            .filter(|e| !matches!(e, Effect::ReadTail(_)))
            .map(|e| match e {
                Effect::Need(Moved::Raised(n)) => format!("raised {}", n.id),
                Effect::Need(Moved::Served(n)) => format!(
                    "served {} by {} {}",
                    n.id,
                    n.served_by
                        .map(|b| b.label().to_owned())
                        .unwrap_or_default(),
                    n.how.map_or("", How::as_str)
                ),
                Effect::Notice(n) => format!(
                    "notice {} armed={} own={} subagent={} replayed={}",
                    n.id, n.origin.armed, n.origin.own_action, n.origin.subagent, n.origin.replayed
                ),
                Effect::Continued(key) => format!("continued {key}"),
                Effect::Read { key, mark, source } => {
                    format!("read {key} {} {source}", mark.device)
                }
                Effect::ReadForgotten(key) => format!("forgot {key}"),
                Effect::Cleared { key, .. } => format!("cleared {key}"),
                Effect::Uncleared(key) => format!("uncleared {key}"),
                Effect::Kept { key, .. } => format!("kept {key}"),
                Effect::Unkept(key) => format!("unkept {key}"),
                Effect::AwayAcked => "away acked".to_owned(),
                Effect::Adopted { key, .. } => format!("adopted {key}"),
                Effect::Unadopted(key) => format!("unadopted {key}"),
                Effect::Colour(write) => format!("colour {write:?}"),
                Effect::ReadTail(_) => unreachable!("filtered above"),
            })
            .collect()
    }

    #[test]
    fn a_question_raises_a_need_that_its_answer_serves_with_the_device_that_answered() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        model.at(1000);
        let changes = event(
            &mut model,
            Some(9),
            r#"{"id":"e","type":"question.asked","properties":{"id":"que_1","sessionID":"ses_1","questions":[{"question":"which greeting?","header":"g","options":[]}]}}"#,
        );
        assert_eq!(
            kinds(&changes),
            ["ask", "thread"],
            "one session: the order cannot move"
        );
        let Change::Thread { thread: session } = &changes[1] else {
            unreachable!()
        };
        assert_eq!(
            (session.needs[0].rank, session.needs[0].body.as_str()),
            (0, "which greeting?")
        );
        assert_eq!(
            told(&mut model),
            [
                "raised ask:desk:que_1",
                "notice ask:desk:que_1 armed=false own=false subagent=false replayed=false"
            ]
        );
        model.answering("desk", "que_1", phone());
        model.at(4000);
        event(
            &mut model,
            Some(10),
            r#"{"id":"e","type":"question.replied","properties":{"sessionID":"ses_1","requestID":"que_1","answers":[["hi"]],"by":"iphone"}}"#,
        );
        assert_eq!(
            told(&mut model),
            ["served ask:desk:que_1 by phone answered"]
        );
        assert_eq!(model.needs_served(1)[0].served_at, Some(4000));
    }

    #[test]
    fn a_daemon_settler_clears_an_ask_without_a_person() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"shell","patterns":["rm -rf build"],"metadata":{},"always":[]}}"#,
        );
        assert_eq!(model.needs_open()[0].body, "run rm -rf build");
        model.drain();
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"permission.replied","properties":{"sessionID":"ses_1","requestID":"per_1","reply":"reject","by":"abort"}}"#,
        );
        assert_eq!(told(&mut model), ["served ask:desk:per_1 by agent dropped"]);
    }

    #[test]
    fn a_turn_a_device_started_is_done_armed_and_the_next_turn_serves_it() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        model.arm("desk:ses_1", "cid-1", phone());
        event(
            &mut model,
            None,
            &message_event("msg_u", "ses_1", "user", false, r#","clientID":"cid-1""#),
        );
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "stop");
        model.drain();
        idle(&mut model, "ses_1");
        assert_eq!(
            told(&mut model),
            [
                "raised done:desk:ses_1:msg_a",
                "notice done:desk:ses_1:msg_a armed=true own=false subagent=false replayed=false"
            ]
        );
        assert_eq!(order(&model)[0], "desk:ses_1");
        busy(&mut model, "ses_1");
        assert_eq!(
            told(&mut model),
            [
                "served done:desk:ses_1:msg_a by agent continued",
                "continued desk:ses_1"
            ]
        );
    }

    /// a resume with cmx2's `compact=1` sends the latest state of each key,
    /// keeping each key's first state event and every status of another
    /// type: a turn that ran wholly inside the gap arrives as busy, each
    /// message's first update, its settled part, its last update and idle.
    /// the done need and its push still come, the journal names each message
    /// before its parts (so a device needs no read for it), and no tail is
    /// read again.
    #[test]
    fn a_turn_run_wholly_inside_a_compacted_gap_still_raises_done_and_reads_nothing() {
        let mut model = Model::new();
        model.at(1_000);
        event(
            &mut model,
            Some(10),
            &updated("ses_1", 1, None).replace("session.updated", "session.created"),
        );
        model.drain();
        let mut changes = Vec::new();
        for (seq, payload) in [
            (20, status("ses_1", r#"{"type":"busy","since":5}"#)),
            (21, message("msg_u", "user", "")),
            (22, message("msg_a", "assistant", "")),
            (
                25,
                text_part(
                    "msg_a",
                    "prt_a",
                    "all done",
                    r#","time":{"start":1,"end":2}"#,
                ),
            ),
            (
                26,
                message_event("msg_a", "ses_1", "assistant", true, r#","finish":"stop""#),
            ),
            (27, status("ses_1", r#"{"type":"idle","since":9}"#)),
        ] {
            changes.extend(event(&mut model, Some(seq), &payload));
        }
        let effects = model.drain();
        assert!(
            !effects.iter().any(|e| matches!(e, Effect::ReadTail(_))),
            "a tail was read again"
        );
        let told: Vec<String> = effects
            .into_iter()
            .filter_map(|e| match e {
                Effect::Need(Moved::Raised(n)) => Some(format!("raised {}", n.id)),
                Effect::Notice(n) => Some(format!("notice {}", n.id)),
                _ => None,
            })
            .collect();
        assert_eq!(
            told,
            [
                "raised done:desk:ses_1:msg_a",
                "notice done:desk:ses_1:msg_a"
            ]
        );
        let message_at = changes
            .iter()
            .position(|c| matches!(c, Change::Message { .. }))
            .expect("the message is journaled");
        let part_at = changes
            .iter()
            .position(|c| matches!(c, Change::Part { .. }))
            .expect("the part is journaled");
        assert!(message_at < part_at, "a part ahead of its message");
        // why cmx2 must keep a status of another type: without busy, the same turn raises nothing
        let mut model = Model::new();
        model.at(1_000);
        event(
            &mut model,
            Some(10),
            &updated("ses_1", 1, None).replace("session.updated", "session.created"),
        );
        event(
            &mut model,
            Some(26),
            &message_event("msg_a", "ses_1", "assistant", true, r#","finish":"stop""#),
        );
        model.drain();
        event(
            &mut model,
            Some(27),
            &status("ses_1", r#"{"type":"idle","since":9}"#),
        );
        assert!(
            !model.drain().iter().any(|e| matches!(e, Effect::Notice(_))),
            "idle alone raises no done"
        );
    }

    #[test]
    fn a_turn_nobody_started_is_done_unarmed() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "stop");
        model.drain();
        idle(&mut model, "ses_1");
        let told = told(&mut model);
        assert_eq!(
            told[1],
            "notice done:desk:ses_1:msg_a armed=false own=false subagent=false replayed=false"
        );
    }

    #[test]
    fn a_turn_that_settles_in_front_of_someone_is_read_not_a_need() {
        let mut model = Model::new();
        model.at(1000);
        event(&mut model, None, &updated("ses_1", 1, None));
        model.looking(vec![Looking {
            device: "mac".into(),
            class: "mac".into(),
            thread: Some("desk:ses_1".into()),
            until: 90_000,
        }]);
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "stop");
        model.drain();
        idle(&mut model, "ses_1");
        assert_eq!(
            told(&mut model),
            [
                "read desk:ses_1 mac watched",
                "notice done:desk:ses_1:msg_a armed=false own=false subagent=false replayed=false"
            ]
        );
        assert!(model.needs_open().is_empty());
        assert_eq!(
            model.entry("desk:ses_1").unwrap().read.unwrap().message,
            "msg_a"
        );
    }

    #[test]
    fn a_subagent_finishing_is_a_notice_and_never_a_need() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_p", 1, None));
        event(&mut model, None, &updated("ses_c", 2, Some("ses_p")));
        busy(&mut model, "ses_c");
        reply(&mut model, "ses_c", "msg_c", "stop");
        model.drain();
        idle(&mut model, "ses_c");
        assert_eq!(
            told(&mut model),
            ["notice done:desk:ses_c:msg_c armed=false own=false subagent=true replayed=false"]
        );
    }

    #[test]
    fn a_turn_cut_off_is_a_fault_unless_the_person_stopped_it() {
        let mut model = Model::new();
        model.at(10_000);
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, None, &updated("ses_2", 1, None));
        model.own_action("desk:ses_1");
        model.at(12_000);
        reply(&mut model, "ses_1", "msg_1", "aborted");
        reply(&mut model, "ses_2", "msg_2", "aborted");
        assert_eq!(
            told(&mut model),
            [
                "notice fault:desk:ses_1:msg_1 armed=false own=true subagent=false replayed=false",
                "raised fault:desk:ses_2:msg_2",
                "notice fault:desk:ses_2:msg_2 armed=false own=false subagent=false replayed=false"
            ]
        );
        assert_eq!(model.needs_open()[0].title, "w stopped");
    }

    #[test]
    fn an_error_a_review_and_a_job_are_needs_in_the_inbox_order() {
        let mut model = Model::new();
        for (id, at) in [
            ("ses_err", 1),
            ("ses_rev", 2),
            ("ses_job", 3),
            ("ses_busy", 4),
        ] {
            event(&mut model, None, &updated(id, at, None));
        }
        busy(&mut model, "ses_busy");
        model.at(100);
        event(
            &mut model,
            Some(1),
            r#"{"id":"e","type":"worktree.review.requested","properties":{"name":"fix-auth","branch":"cmx2/fix-auth","sessionID":"ses_rev"}}"#,
        );
        model.at(200);
        event(
            &mut model,
            Some(2),
            r#"{"id":"e","type":"session.error","properties":{"sessionID":"ses_err","error":{"name":"ProviderError","data":{"message":"the provider is down"}}}}"#,
        );
        model.at(300);
        event(
            &mut model,
            Some(3),
            r#"{"id":"e","type":"process.notify","properties":{"process":{"id":"proc_1","sessionID":"ses_job","pid":1,"command":"bun test","cwd":"/w","title":"bun test","kind":"job","status":"exited","exitCode":0,"ports":[],"origin":"model","startedAt":1},"reason":"exit","detail":"118 passed"}}"#,
        );
        // a job notice is not a need by default (decision 95): the job thread ranks as the idle thread it is
        assert_eq!(
            order(&model)[..4],
            [
                "desk:ses_err",
                "desk:ses_rev",
                "desk:ses_busy",
                "desk:ses_job"
            ]
        );
        let counting = model.set_home(HomePrefs {
            jobs_as_needs: true,
            ..HomePrefs::default()
        });
        assert_eq!(kinds(&counting), ["order"], "the pref re-ranks at once");
        assert_eq!(
            order(&model)[..4],
            [
                "desk:ses_err",
                "desk:ses_job",
                "desk:ses_rev",
                "desk:ses_busy"
            ]
        );
        let told = told(&mut model);
        assert!(told.contains(&"raised review:desk:ses_rev:fix-auth:1".to_owned()));
        assert!(told.contains(&"raised job:desk:ses_job:proc_1:exit:3".to_owned()));
        assert!(
            !told.iter().any(|t| t.starts_with("notice job:")),
            "a job notice is not pushed"
        );
        event_in(
            &mut model,
            Some(4),
            "/w",
            r#"{"id":"e","type":"worktree.merged","properties":{"name":"fix-auth","branch":"cmx2/fix-auth","base":"main","commit":"abc","commits":1}}"#,
        );
        assert_eq!(
            told_of(&mut model),
            ["served review:desk:ses_rev:fix-auth:1 by agent settled"]
        );
    }

    fn told_of(model: &mut Model) -> Vec<String> {
        told(model)
    }

    const REVIEW_REQUESTED: &str = r#"{"id":"e","type":"worktree.review.requested","properties":{"name":"fix-auth","branch":"cmx2/fix-auth","sessionID":"ses_1"}}"#;

    #[test]
    fn a_turn_the_agent_started_does_not_serve_its_review() {
        // a child's report wakes the agent; that says nothing about the checkout it asked about
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.drain();
        busy(&mut model, "ses_1");
        assert_eq!(told(&mut model), ["continued desk:ses_1"]);
        let open = model.needs_open();
        assert_eq!(open.len(), 1, "the review is still open");
        assert_eq!(open[0].kind, NeedKind::Review);
    }

    #[test]
    fn a_turn_woken_from_a_park_does_not_serve_the_review_a_devices_turn_left() {
        // the daemon's order: a phone's prompt turns the session busy, then its message lands; the
        // agent spawns a helper and asks for review, the turn parks on the helper, and the helper's
        // report wakes the agent. the device started the first turn, not the second
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        model.arm("desk:ses_1", "cid-1", phone());
        busy(&mut model, "ses_1");
        event(
            &mut model,
            None,
            &message_event("msg_u", "ses_1", "user", false, r#","clientID":"cid-1""#),
        );
        event(&mut model, Some(1), REVIEW_REQUESTED);
        event(
            &mut model,
            None,
            &status(
                "ses_1",
                r#"{"type":"idle","since":9,"parked":{"agents":1,"jobs":0}}"#,
            ),
        );
        model.drain();
        busy(&mut model, "ses_1");
        assert_eq!(told(&mut model), ["continued desk:ses_1"]);
        let open = model.needs_open();
        assert_eq!(open.len(), 1, "the review is still open: {open:?}");
        assert_eq!(open[0].kind, NeedKind::Review);
    }

    #[test]
    fn a_turn_a_device_started_serves_the_review_and_the_agents_next_turn_serves_nothing_more() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.drain();
        model.arm("desk:ses_1", "cid-1", phone());
        event(
            &mut model,
            None,
            &message_event("msg_u", "ses_1", "user", false, r#","clientID":"cid-1""#),
        );
        busy(&mut model, "ses_1");
        let told = told(&mut model);
        assert_eq!(told.len(), 2, "{told:?}");
        assert!(
            told[0].starts_with("served review:desk:ses_1:fix-auth:1 by ")
                && told[0].ends_with(" continued"),
            "{told:?}"
        );
        assert!(
            !told[0].contains("by agent"),
            "a device served it: {told:?}"
        );
        assert_eq!(told[1], "continued desk:ses_1");
        assert!(model.needs_open().is_empty());
    }

    #[test]
    fn a_review_a_turn_left_open_is_served_when_the_checkout_merges_or_is_discarded() {
        for ended in ["worktree.merged", "worktree.discarded"] {
            let mut model = Model::new();
            event(&mut model, None, &updated("ses_1", 1, None));
            event(&mut model, Some(1), REVIEW_REQUESTED);
            busy(&mut model, "ses_1");
            model.drain();
            event_in(
                &mut model,
                Some(2),
                "/w",
                &format!(
                    r#"{{"id":"e","type":"{ended}","properties":{{"name":"fix-auth","branch":"cmx2/fix-auth","base":"main","commit":"abc","commits":1}}}}"#
                ),
            );
            assert_eq!(
                told(&mut model),
                ["served review:desk:ses_1:fix-auth:1 by agent settled"],
                "{ended}"
            );
        }
    }

    const MERGED: &str = r#"{"id":"e","type":"worktree.merged","properties":{"name":"fix-auth","branch":"cmx2/fix-auth","base":"main","commit":"abc","commits":1}}"#;

    fn open_reviews(model: &Model) -> Vec<String> {
        model
            .needs_open()
            .into_iter()
            .filter(|n| n.kind == NeedKind::Review)
            .map(|n| n.id)
            .collect()
    }

    #[test]
    fn each_request_for_review_is_its_own_need_and_a_newer_one_answers_the_older() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(3), REVIEW_REQUESTED);
        assert_eq!(open_reviews(&model), ["review:desk:ses_1:fix-auth:3"]);
        model.drain();
        // sent back with notes, the agent asks again with a new note
        let again =
            REVIEW_REQUESTED.replace(r#""sessionID""#, r#""note":"adds second.txt","sessionID""#);
        event(&mut model, Some(9), &again);
        assert_eq!(open_reviews(&model), ["review:desk:ses_1:fix-auth:9"]);
        assert_eq!(
            model.needs_open()[0].body,
            "adds second.txt",
            "the card reads the new note"
        );
        let told = told(&mut model);
        assert!(
            told.contains(&"served review:desk:ses_1:fix-auth:3 by agent continued".to_owned()),
            "{told:?}"
        );
        assert!(
            told.contains(&"raised review:desk:ses_1:fix-auth:9".to_owned()),
            "{told:?}"
        );
    }

    #[test]
    fn a_request_replayed_after_it_was_served_raises_nothing_and_serves_nothing() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(3), REVIEW_REQUESTED);
        event(&mut model, Some(9), REVIEW_REQUESTED);
        model.drain();
        event(&mut model, Some(3), REVIEW_REQUESTED);
        assert_eq!(told(&mut model), Vec::<String>::new());
        assert_eq!(open_reviews(&model), ["review:desk:ses_1:fix-auth:9"]);
    }

    #[test]
    fn an_agent_sent_back_with_notes_that_asks_again_gets_a_card_after_its_review_was_served() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.review_answered("desk:ses_1", &phone());
        assert!(open_reviews(&model).is_empty());
        event(&mut model, Some(2), REVIEW_REQUESTED);
        assert_eq!(open_reviews(&model), ["review:desk:ses_1:fix-auth:2"]);
    }

    #[test]
    fn a_reply_through_boxbox_serves_the_review_by_the_device_that_sent_it() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.drain();
        let changes = model.review_answered("desk:ses_1", &phone());
        assert_eq!(
            kinds(&changes),
            ["thread"],
            "the entry loses its need on every device"
        );
        assert_eq!(
            told(&mut model),
            ["served review:desk:ses_1:fix-auth:1 by phone continued"]
        );
        assert!(model.needs_open().is_empty());
    }

    #[test]
    fn a_reply_to_a_thread_with_no_review_changes_nothing() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        model.drain();
        assert!(model.review_answered("desk:ses_1", &phone()).is_empty());
        assert!(model.review_answered("desk:ses_9", &phone()).is_empty());
        assert_eq!(told(&mut model), Vec::<String>::new());
    }

    #[test]
    fn a_checkout_the_daemon_says_is_gone_serves_its_review_as_settled() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.drain();
        let changes = model.review_gone("desk:ses_1");
        assert_eq!(kinds(&changes), ["thread"]);
        assert_eq!(
            told(&mut model),
            ["served review:desk:ses_1:fix-auth:1 by agent settled"]
        );
        assert!(model.needs_open().is_empty(), "the badge is empty");
    }

    #[test]
    fn a_merge_settles_the_review_of_the_repo_it_was_in_and_not_another_with_a_checkout_of_the_same_name()
     {
        let mut model = Model::new();
        event(
            &mut model,
            None,
            &updated_in("ses_1", 1, "/work/site/fix-auth"),
        );
        event(
            &mut model,
            None,
            &updated_in("ses_2", 2, "/work/api/fix-auth"),
        );
        let request = |session: &str| REVIEW_REQUESTED.replace("ses_1", session);
        event(&mut model, Some(1), &request("ses_1"));
        event(&mut model, Some(2), &request("ses_2"));
        model.drain();
        event_in(&mut model, Some(3), "/work/site/fix-auth", MERGED);
        assert_eq!(
            told(&mut model),
            ["served review:desk:ses_1:fix-auth:1 by agent settled"]
        );
        assert_eq!(open_reviews(&model), ["review:desk:ses_2:fix-auth:2"]);
    }

    #[test]
    fn a_session_working_inside_the_checkout_is_in_it_and_one_in_a_sibling_directory_is_not() {
        assert!(is_inside("/w/fix", "/w/fix"));
        assert!(is_inside("/w/fix/app", "/w/fix"));
        assert!(is_inside("/w/fix/app", "/w/fix/"));
        assert!(!is_inside("/w/fix-auth", "/w/fix"));
        assert!(!is_inside("/w", "/w/fix"));
    }

    #[test]
    fn a_worktree_event_with_no_directory_settles_nothing() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.drain();
        event(&mut model, Some(2), MERGED);
        assert_eq!(
            open_reviews(&model).len(),
            1,
            "the card finds the checkout gone when it reads it"
        );
    }

    #[test]
    fn a_turn_whose_status_comes_before_its_message_is_still_the_devices_that_sent_it() {
        // cmx2 says busy, then the prompt's message: the send is still armed when the status lands
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.drain();
        model.arm("desk:ses_1", "cid-1", phone());
        busy(&mut model, "ses_1");
        let told = told(&mut model);
        assert_eq!(
            told[0], "served review:desk:ses_1:fix-auth:1 by phone continued",
            "{told:?}"
        );
    }

    #[test]
    fn a_send_that_never_landed_does_not_make_a_turn_minutes_later_the_devices() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        event(&mut model, Some(1), REVIEW_REQUESTED);
        model.drain();
        model.at(1_000);
        model.arm("desk:ses_1", "cid-1", phone());
        model.at(1_000 + SEND_STARTS_WITHIN_MS + 1);
        busy(&mut model, "ses_1");
        assert_eq!(told(&mut model), ["continued desk:ses_1"]);
        assert_eq!(open_reviews(&model).len(), 1);
    }

    #[test]
    fn a_done_a_device_sent_the_next_turn_for_is_served_by_that_device_when_busy_comes_first() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "stop");
        idle(&mut model, "ses_1");
        model.drain();
        model.arm("desk:ses_1", "cid-2", phone());
        busy(&mut model, "ses_1");
        let told = told(&mut model);
        assert_eq!(
            told[0], "served done:desk:ses_1:msg_a by phone continued",
            "{told:?}"
        );
    }

    #[test]
    fn the_review_routes_find_a_sessions_directory_and_its_open_checkout() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        assert_eq!(
            model.review_target("desk:ses_1"),
            Some(ReviewTarget {
                directory: "/w".into(),
                checkout: None
            }),
            "a thread nobody asked a review of still has its directory"
        );
        event(&mut model, Some(1), REVIEW_REQUESTED);
        assert_eq!(
            model.review_target("desk:ses_1").and_then(|t| t.checkout),
            Some("fix-auth".into())
        );
        assert_eq!(model.review_target("desk:ses_9"), None);
        event_in(
            &mut model,
            Some(2),
            "/w",
            r#"{"id":"e","type":"worktree.merged","properties":{"name":"fix-auth","branch":"cmx2/fix-auth","base":"main","commit":"abc","commits":1}}"#,
        );
        assert_eq!(
            model.review_target("desk:ses_1").and_then(|t| t.checkout),
            None,
            "a merged checkout is no longer the review's"
        );
    }

    #[test]
    fn a_reread_ask_already_raised_is_judged_as_replayed_and_raised_once() {
        let mut model = Model::new();
        let ask = r#"{"id":"que_1","sessionID":"ses_1","questions":[{"question":"q?","header":"h","options":[]}]}"#;
        let read = || {
            let mut read = empty_read(5);
            read.sessions
                .data
                .push(raw(&info("ses_1", 1, None)).unwrap());
            read.questions.data.push(raw(ask).unwrap());
            read
        };
        model.host_read(read());
        assert_eq!(told(&mut model)[0], "raised ask:desk:que_1");
        model.host_read(read());
        assert_eq!(
            told(&mut model),
            ["notice ask:desk:que_1 armed=false own=false subagent=false replayed=true"]
        );
        // answered while boxbox was away: the next read serves it
        model.host_read(empty_read(9));
        assert_eq!(told(&mut model)[0], "served ask:desk:que_1 by agent gone");
    }

    #[test]
    fn a_read_mark_serves_done_and_never_moves_back() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_1", 1, None));
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "stop");
        idle(&mut model, "ses_1");
        model.drain();
        assert!(model.read("desk:ses_1", &phone(), "msg_old", 50.0).is_ok());
        assert_eq!(
            told(&mut model),
            ["read desk:ses_1 phone thread"],
            "an older mark serves nothing"
        );
        let changes = model.read("desk:ses_1", &phone(), "msg_a", 100.0).unwrap();
        assert_eq!(
            told(&mut model),
            [
                "read desk:ses_1 phone thread",
                "served done:desk:ses_1:msg_a by phone seen"
            ]
        );
        assert!(kinds(&changes).contains(&"thread"));
        assert!(model.read("desk:nope", &phone(), "m", 1.0).is_err());
    }

    #[test]
    fn a_need_restored_from_the_store_is_served_by_looking_at_its_thread() {
        let restored = Need::new(
            "done:desk:ses_1:msg_a".into(),
            NeedKind::Done,
            "desk:ses_1",
            5,
            "w is done".into(),
            "ok",
        );
        let mut model = Model::restore(
            Needs::restore(vec![restored], vec![]),
            Reads::default(),
            Clears::default(),
            Vec::new(),
        );
        model.at(1000);
        let mut read = empty_read(5);
        read.sessions
            .data
            .push(raw(&info("ses_1", 1, None)).unwrap());
        model.host_read(read);
        model.drain();
        model.looking(vec![Looking {
            device: "mac".into(),
            class: "mac".into(),
            thread: Some("desk:ses_1".into()),
            until: 90_000,
        }]);
        assert_eq!(
            told(&mut model),
            ["served done:desk:ses_1:msg_a by mac seen"]
        );
    }

    /* —— window tails read from the daemon: once per window, lined up by seq —— */

    /// the tail reads asked for since the last drain, by session key.
    fn asked(model: &mut Model) -> Vec<String> {
        model
            .drain()
            .into_iter()
            .filter_map(|e| match e {
                Effect::ReadTail(request) if !request.newest => Some(request.key),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn an_ask_settle_is_judged_against_its_own_kinds_floor() {
        let mut model = Model::new();
        let mut read = empty_read(10);
        read.questions.seq = 2;
        model.host_read(read);
        event(
            &mut model,
            Some(11),
            r#"{"id":"e","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"read","patterns":[],"metadata":{},"always":[]}}"#,
        );
        event(
            &mut model,
            Some(12),
            r#"{"id":"e","type":"question.asked","properties":{"id":"que_1","sessionID":"ses_1","questions":[{"question":"which?","header":"pick","options":[]}]}}"#,
        );
        // seq 5 is past the questions' floor (2) and inside the permissions' (10)
        let question = event(
            &mut model,
            Some(5),
            r#"{"id":"e","type":"question.replied","properties":{"sessionID":"ses_1","requestID":"que_1","answers":[]}}"#,
        );
        let permission = event(
            &mut model,
            Some(5),
            r#"{"id":"e","type":"permission.replied","properties":{"sessionID":"ses_1","requestID":"per_1","reply":"once"}}"#,
        );
        assert!(kinds(&question).contains(&"ask.settled"));
        assert!(!kinds(&permission).contains(&"ask.settled"));
    }

    /// the host read afresh at `seq` in `epoch`, holding `sessions`.
    fn host_read_of(epoch: &str, seq: u64, sessions: &[String]) -> HostRead {
        let mut read = empty_read(seq);
        read.epoch = epoch.into();
        read.sessions.data = sessions.iter().map(|s| raw(s).unwrap()).collect();
        read
    }

    fn read_message(id: &str, role: &str, parts: &[String]) -> String {
        format!(
            r#"{{"info":{{"id":"{id}","sessionID":"ses_1","role":"{role}","time":{{"created":100}}}},"parts":[{}]}}"#,
            parts.join(",")
        )
    }

    fn read_part(message: &str, part: &str, kind: &str, text: &str, rest: &str) -> String {
        format!(
            r#"{{"id":"{part}","sessionID":"ses_1","messageID":"{message}","type":"{kind}","text":"{text}"{rest}}}"#
        )
    }

    fn tail_read_of(epoch: &str, seq: u64, messages: &[String]) -> (String, Cursor, String) {
        (
            "desk:ses_1".into(),
            Cursor {
                epoch: epoch.into(),
                seq,
            },
            format!("[{}]", messages.join(",")),
        )
    }

    fn texts(model: &Model) -> Vec<String> {
        tail(model).into_iter().map(|t| t.text).collect()
    }

    /// `ses_1` known through a host read and asked for, nothing else yet.
    fn asked_for_ses_1() -> Model {
        let mut model = Model::new();
        model.host_read(host_read_of("ep", 5, &[info("ses_1", 1, None)]));
        assert_eq!(asked(&mut model), ["desk:ses_1"]);
        model
    }

    #[test]
    fn a_session_with_a_window_has_its_tail_asked_for_once_and_only_once() {
        let mut model = Model::new();
        model.host_read(host_read_of("ep", 5, &[info_rev("ses_1", 1, 3)]));
        assert_eq!(asked(&mut model), ["desk:ses_1"]);
        event(&mut model, Some(6), &updated("ses_1", 2, None));
        event(&mut model, Some(7), &status("ses_1", r#"{"type":"busy"}"#));
        model.host_read(host_read_of("ep", 8, &[info_rev("ses_1", 2, 3)]));
        assert!(asked(&mut model).is_empty(), "asked while the read is out");
        model.tail_read(tail_read_of("ep", 8, &[]));
        event(&mut model, Some(9), &updated("ses_1", 3, None));
        // its transcript did not move and it is not busy: the quiet re-read keeps its tail
        model.host_read(host_read_of("ep", 10, &[info_rev("ses_1", 3, 3)]));
        assert!(
            asked(&mut model).is_empty(),
            "asked again after it was read"
        );
        // a daemon that does not number transcripts: no revision says it held still
        model.tail_read(tail_read_of("ep", 10, &[]));
        model.host_read(host_read_of("ep", 11, &[info("ses_1", 3, None)]));
        assert_eq!(asked(&mut model), ["desk:ses_1"]);
    }

    #[test]
    fn a_session_without_a_window_or_a_subagent_is_never_asked_for() {
        let mut model = Model::new();
        // two days on, a session last touched at the start is idle, old and asks nothing
        model.at(2 * 24 * 60 * 60 * 1000);
        model.host_read(host_read_of(
            "ep",
            5,
            &[
                info("ses_old", 1, None),
                info("ses_kid", 2 * 24 * 60 * 60 * 1000, Some("ses_old")),
            ],
        ));
        event(&mut model, Some(6), &updated("ses_old", 1, None));
        event(
            &mut model,
            Some(7),
            &status("ses_kid", r#"{"type":"busy"}"#),
        );
        assert!(asked(&mut model).is_empty());
        // the old one gets a window the moment it works again, and only then is it read
        event(
            &mut model,
            Some(8),
            &status("ses_old", r#"{"type":"busy"}"#),
        );
        assert_eq!(asked(&mut model), ["desk:ses_old"]);
    }

    #[test]
    fn a_read_fills_the_tail_with_the_last_twelve_items_on_the_right_sides() {
        let mut model = asked_for_ses_1();
        let first: Vec<String> = (1..=12)
            .map(|n| read_part("msg_a1", &format!("p{n}"), "text", &format!("step {n}"), ""))
            .collect();
        let changes = model.tail_read(tail_read_of(
            "ep",
            5,
            &[
                read_message("msg_u1", "user", &[read_part("msg_u1", "u1", "text", "first prompt", "")]),
                read_message("msg_a1", "assistant", &first),
                read_message(
                    "msg_u2",
                    "user",
                    &[
                        read_part("msg_u2", "ctx", "text", "the turn context", r#","synthetic":true"#),
                        read_part("msg_u2", "u2", "text", "second prompt", ""),
                    ],
                ),
                read_message(
                    "msg_a2",
                    "assistant",
                    &[
                        r#"{"id":"st","sessionID":"ses_1","messageID":"msg_a2","type":"step-start"}"#.into(),
                        read_part("msg_a2", "a2", "text", "the answer", ""),
                    ],
                ),
            ],
        ));
        assert_eq!(kinds(&changes), ["thread"]);
        let tail = tail(&model);
        assert_eq!(tail.len(), TAIL_ITEMS);
        assert_eq!(
            tail[0].text, "step 3",
            "the oldest items fell off the front"
        );
        assert_eq!(
            (tail[10].text.as_str(), tail[10].role),
            ("second prompt", TailRole::User)
        );
        assert_eq!(
            (tail[11].text.as_str(), tail[11].role),
            ("the answer", TailRole::Assistant)
        );
        assert!(!texts(&model).contains(&"the turn context".to_owned()));
    }

    #[test]
    fn events_after_the_reads_seq_apply_exactly_once_and_those_before_never_turn_it_back() {
        let mut model = asked_for_ses_1();
        // while the read is out: one event the read has (4), one it does not (7), a delta inside the read's text
        event(
            &mut model,
            Some(4),
            &text_part("msg_a", "p_old", "stale", ""),
        );
        event(
            &mut model,
            Some(7),
            &text_part("msg_a", "p_new", "after the read", ""),
        );
        event(&mut model, None, &delta("msg_a", "p_old", "fre", 0));
        model.tail_read(tail_read_of(
            "ep",
            6,
            &[read_message(
                "msg_a",
                "assistant",
                &[read_part("msg_a", "p_old", "text", "fresh", "")],
            )],
        ));
        assert_eq!(texts(&model), ["fresh", "after the read"]);
        // after the read: one at or below its seq arrives late and changes nothing
        let late = event(
            &mut model,
            Some(6),
            &text_part("msg_a", "p_old", "late and stale", ""),
        );
        assert_eq!(
            kinds(&late),
            ["part"],
            "journaled for clients, kept out of the tail"
        );
        assert_eq!(texts(&model), ["fresh", "after the read"]);
        // one past it applies; a delta past the read's text appends once by its offset
        event(
            &mut model,
            Some(8),
            &text_part("msg_a", "p_old", "fresher", ""),
        );
        event(&mut model, None, &delta("msg_a", "p_new", " and more", 14));
        event(&mut model, None, &delta("msg_a", "p_new", " and more", 14));
        assert_eq!(texts(&model), ["fresher", "after the read and more"]);
    }

    #[test]
    fn what_changes_while_a_read_is_out_is_kept_in_a_bounded_buffer() {
        let mut model = asked_for_ses_1();
        model.at(1_000);
        let mut offset = 0;
        for _ in 0..200 {
            event(&mut model, None, &delta("msg_a", "p_live", "word ", offset));
            offset += 5;
        }
        for n in 0..30 {
            event(
                &mut model,
                Some(10 + n),
                &text_part("msg_a", "p_tool", &format!("v{n}"), ""),
            );
        }
        let Hydration::Asked {
            since, overflowed, ..
        } = &model.sessions["desk:ses_1"].tail.hydration
        else {
            panic!("not asked")
        };
        assert!(!overflowed);
        assert_eq!(
            since.len(),
            2,
            "200 contiguous deltas are one op, 30 versions of a part are one"
        );
        let Some(TailOp::Stream {
            delta,
            offset: start,
            ..
        }) = since.first()
        else {
            panic!("{since:?}")
        };
        assert_eq!(
            delta.chars().count(),
            2 * TAIL_TEXT,
            "the delta keeps the end of what streamed"
        );
        assert_eq!(*start + utf16_len(delta), 1000);
    }

    #[test]
    fn a_read_overtaken_by_more_than_the_buffer_holds_is_taken_again_at_most_three_times() {
        let mut model = asked_for_ses_1();
        let mut seq = 10;
        for attempt in 1..=3 {
            for _ in 0..=TAIL_OPS {
                seq += 1;
                event(
                    &mut model,
                    Some(seq),
                    &text_part("msg_a", &format!("p{seq}"), "live", ""),
                );
            }
            assert!(
                model.tail_read(tail_read_of("ep", seq, &[])).is_empty(),
                "attempt {attempt}"
            );
            assert_eq!(texts(&model).len(), TAIL_ITEMS, "the live tail stays");
            let again = asked(&mut model);
            if attempt < 3 {
                assert_eq!(again, ["desk:ses_1"], "attempt {attempt}");
            } else {
                assert!(
                    again.is_empty(),
                    "three overtaken reads, and the live tail is kept"
                );
            }
        }
        event(&mut model, Some(seq + 1), &updated("ses_1", 2, None));
        assert!(asked(&mut model).is_empty());
    }

    #[test]
    fn a_read_from_another_epoch_is_dropped_and_the_host_read_that_moved_it_asks_again() {
        let mut model = asked_for_ses_1();
        let stale = tail_read_of(
            "old",
            9,
            &[read_message(
                "msg_a",
                "assistant",
                &[read_part("msg_a", "p", "text", "from before", "")],
            )],
        );
        assert!(model.tail_read(stale).is_empty());
        assert!(tail(&model).is_empty());
        model.host_read(host_read_of("ep2", 1, &[info("ses_1", 1, None)]));
        assert_eq!(asked(&mut model), ["desk:ses_1"]);
        model.tail_read(tail_read_of(
            "ep2",
            1,
            &[read_message(
                "msg_a",
                "assistant",
                &[read_part("msg_a", "p", "text", "now", "")],
            )],
        ));
        assert_eq!(texts(&model), ["now"]);
    }

    #[test]
    fn a_session_seen_being_born_is_never_read() {
        let mut model = Model::new();
        model.host_read(host_read_of("ep", 5, &[]));
        event(
            &mut model,
            Some(6),
            &format!(
                r#"{{"id":"e","type":"session.created","properties":{{"sessionID":"ses_1","info":{}}}}}"#,
                info("ses_1", 1, None)
            ),
        );
        event(&mut model, Some(7), &status("ses_1", r#"{"type":"busy"}"#));
        assert!(asked(&mut model).is_empty());
        event(
            &mut model,
            Some(8),
            &text_part("msg_a", "p", "streams in", ""),
        );
        assert_eq!(texts(&model), ["streams in"]);
    }

    #[test]
    fn a_failed_read_is_asked_again_when_the_host_is_next_read_never_per_event() {
        let mut model = asked_for_ses_1();
        model.tail_failed("desk:ses_1");
        event(&mut model, Some(6), &updated("ses_1", 2, None));
        assert!(asked(&mut model).is_empty());
        model.host_read(host_read_of("ep", 7, &[info("ses_1", 2, None)]));
        assert_eq!(asked(&mut model), ["desk:ses_1"]);
    }

    #[test]
    fn a_request_that_could_not_be_queued_is_asked_on_the_next_change() {
        let mut model = asked_for_ses_1();
        model.tail_not_asked("desk:ses_1");
        event(&mut model, Some(6), &updated("ses_1", 2, None));
        assert_eq!(asked(&mut model), ["desk:ses_1"]);
    }

    /* —— contract 5: every streamed part is announced, thinking streams —— */

    fn reasoning_part(message: &str, part: &str, text: &str, rest: &str) -> String {
        text_part(message, part, text, rest).replace(r#""type":"text""#, r#""type":"reasoning""#)
    }

    fn announced(rest: &str) -> String {
        format!(r#","streaming":true,"time":{{"start":{rest}}}"#)
    }

    fn kinds_in(model: &Model) -> Vec<(TailKind, String)> {
        tail(model).into_iter().map(|t| (t.kind, t.text)).collect()
    }

    #[test]
    fn an_announced_text_part_is_not_an_entry_until_its_first_words_and_then_streams_by_beats() {
        let mut model = replying(0);
        model.at(1_000);
        let announce = event(
            &mut model,
            Some(7),
            &text_part("msg_a", "prt_a", "", &announced("1000")),
        );
        assert_eq!(
            kinds(&announce),
            ["part"],
            "nothing a window shows has changed"
        );
        assert_eq!(
            kinds_in(&model),
            [(TailKind::Text, String::new())],
            "the item is held for the deltas to grow"
        );
        model.at(2_000);
        let first = event(
            &mut model,
            None,
            &delta("msg_a", "prt_a", "the limiter ", 0),
        );
        assert_eq!(
            kinds(&first),
            ["delta", "thread"],
            "the first words go out at once"
        );
        model.at(2_050);
        let held = event(
            &mut model,
            None,
            &delta("msg_a", "prt_a", "is a bucket.", 12),
        );
        assert_eq!(kinds(&held), ["delta"], "inside the beat it is held");
        assert_eq!(texts(&model), ["the limiter is a bucket."]);
        let whole = event(
            &mut model,
            Some(8),
            &text_part(
                "msg_a",
                "prt_a",
                "the limiter is a bucket.",
                r#","time":{"start":1000,"end":2100}"#,
            ),
        );
        assert_eq!(
            kinds(&whole),
            ["part"],
            "the final part says what the tail holds"
        );
    }

    #[test]
    fn an_announced_reasoning_part_streams_into_the_tail_without_an_entry_a_beat() {
        let mut model = replying(0);
        model.at(1_000);
        let announce = event(
            &mut model,
            Some(7),
            &reasoning_part("msg_a", "prt_r", "", &announced("1000")),
        );
        assert_eq!(kinds(&announce), ["part"]);
        let mut offset = 0;
        let mut entries = 0;
        for n in 0..100 {
            model.at(1_100 + 10 * n);
            let changes = event(&mut model, None, &delta("msg_a", "prt_r", "weigh ", offset));
            offset += 6;
            assert_eq!(kinds(&changes), ["delta"], "delta {n}");
            entries += sessions_in(&changes);
        }
        assert_eq!(entries, 0);
        assert_eq!(model.tail_due(), None, "no beat is held for thinking");
        let held = tail(&model);
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].kind, TailKind::Reasoning, "it stays thinking");
        assert!(held[0].text.ends_with("weigh weigh "));
        assert_eq!(
            model.sessions["desk:ses_1"].tail.items[0].streamed, 600,
            "the next delta lands where it should"
        );
        // the text part after it does stream by beats, beside the thought
        event(
            &mut model,
            Some(8),
            &text_part("msg_a", "prt_t", "", &announced("2200")),
        );
        model.at(3_000);
        let first = event(&mut model, None, &delta("msg_a", "prt_t", "so", 0));
        assert_eq!(kinds(&first), ["delta", "thread"]);
        let order: Vec<TailKind> = tail(&model).iter().map(|t| t.kind).collect();
        assert_eq!(order, [TailKind::Reasoning, TailKind::Text]);
        // the final reasoning part, whole, with its time, changes nothing a window shows
        let whole = event(
            &mut model,
            Some(9),
            &reasoning_part(
                "msg_a",
                "prt_r",
                &"weigh ".repeat(100),
                r#","time":{"start":1000,"end":2100}"#,
            ),
        );
        assert_eq!(kinds_in(&model)[0].0, TailKind::Reasoning);
        assert_eq!(sessions_in(&whole), 0);
    }

    #[test]
    fn an_announcement_during_the_tail_read_replays_in_order_on_the_read() {
        let mut model = asked_for_ses_1();
        model.at(1_000);
        // while the read is out: the reasoning is announced and streams, then the text is announced and streams
        event(
            &mut model,
            Some(7),
            &reasoning_part("msg_a", "prt_r", "", &announced("900")),
        );
        event(&mut model, None, &delta("msg_a", "prt_r", "weighing ", 0));
        event(&mut model, None, &delta("msg_a", "prt_r", "the options", 9));
        event(
            &mut model,
            Some(8),
            &text_part("msg_a", "prt_t", "", &announced("950")),
        );
        event(&mut model, None, &delta("msg_a", "prt_t", "the answer", 0));
        // the read is at 6: the earlier message, nothing of the turn
        model.tail_read(tail_read_of(
            "ep",
            6,
            &[read_message(
                "msg_old",
                "assistant",
                &[read_part("msg_old", "p_old", "text", "earlier", "")],
            )],
        ));
        assert_eq!(
            kinds_in(&model),
            [
                (TailKind::Text, "earlier".to_owned()),
                (TailKind::Reasoning, "weighing the options".to_owned()),
                (TailKind::Text, "the answer".to_owned()),
            ]
        );
    }

    #[test]
    fn a_read_that_already_holds_the_started_parts_is_continued_by_the_deltas_after_it() {
        let mut model = asked_for_ses_1();
        model.at(1_000);
        // the read at 8 holds both parts as the in-flight read serves them: typed, text so far, streaming
        event(
            &mut model,
            Some(7),
            &reasoning_part("msg_a", "prt_r", "", &announced("900")),
        );
        event(&mut model, None, &delta("msg_a", "prt_r", "weighing ", 0));
        event(
            &mut model,
            Some(8),
            &text_part("msg_a", "prt_t", "", &announced("950")),
        );
        event(&mut model, None, &delta("msg_a", "prt_r", "the options", 9));
        event(&mut model, None, &delta("msg_a", "prt_t", "the answer", 0));
        model.tail_read(tail_read_of(
            "ep",
            8,
            &[read_message(
                "msg_a",
                "assistant",
                &[
                    read_part(
                        "msg_a",
                        "prt_r",
                        "reasoning",
                        "weighing ",
                        &announced("900"),
                    ),
                    read_part("msg_a", "prt_t", "text", "", &announced("950")),
                ],
            )],
        ));
        assert_eq!(
            kinds_in(&model),
            [
                (TailKind::Reasoning, "weighing the options".to_owned()),
                (TailKind::Text, "the answer".to_owned()),
            ],
            "each delta counted once"
        );
    }

    #[test]
    fn a_zero_point_eight_three_turn_still_creates_text_by_its_first_delta() {
        let mut model = replying(0);
        model.at(1_000);
        // no announcement: the first delta at offset 0 is the part's birth
        let born = event(&mut model, None, &delta("msg_a", "prt_t", "the notes", 0));
        assert_eq!(kinds(&born), ["delta", "thread"]);
        assert_eq!(kinds_in(&model), [(TailKind::Text, "the notes".to_owned())]);
        // a delta for a part born past its start waits for the whole part
        event(&mut model, None, &delta("msg_a", "prt_x", "mid", 5));
        assert_eq!(tail(&model).len(), 1);
        // the thinking lands whole when the step ends, with no stream before it
        let thought = event(
            &mut model,
            Some(9),
            &reasoning_part("msg_a", "prt_r", "the person wants the state", ""),
        );
        assert_eq!(sessions_in(&thought), 0);
        assert_eq!(
            kinds_in(&model),
            [
                (TailKind::Text, "the notes".to_owned()),
                (TailKind::Reasoning, "the person wants the state".to_owned()),
            ]
        );
        let whole = event(
            &mut model,
            Some(10),
            &text_part("msg_a", "prt_t", "the notes", ""),
        );
        assert_eq!(kinds(&whole), ["part"]);
    }

    /* —— a26: a part's final comes when its block ends, and again at the step's end —— */

    #[test]
    fn a_reasoning_final_published_when_its_block_ends_writes_no_tail_entry() {
        let mut model = replying(0);
        model.at(1_000);
        event(
            &mut model,
            Some(7),
            &reasoning_part("msg_a", "prt_r", "", &announced("1000")),
        );
        event(&mut model, None, &delta("msg_a", "prt_r", "weighing ", 0));
        event(&mut model, None, &delta("msg_a", "prt_r", "the options", 9));
        let before = tail(&model);
        // the thought ends: its final, whole, with time {start, end} and no streaming flag
        let ended = r#","time":{"start":1000,"end":1500}"#;
        let early = event(
            &mut model,
            Some(8),
            &reasoning_part("msg_a", "prt_r", "weighing the options", ended),
        );
        assert_eq!(
            kinds(&early),
            ["part"],
            "the part is journaled for clients, nothing else"
        );
        assert_eq!(tail(&model), before, "the tail holds the same thought");
        // the reply begins after it; the step's end publishes the same final again
        event(
            &mut model,
            Some(9),
            &text_part("msg_a", "prt_t", "", &announced("1501")),
        );
        model.at(2_000);
        let first = event(&mut model, None, &delta("msg_a", "prt_t", "the answer", 0));
        assert_eq!(kinds(&first), ["delta", "thread"]);
        let again = event(
            &mut model,
            Some(10),
            &reasoning_part("msg_a", "prt_r", "weighing the options", ended),
        );
        assert_eq!(kinds(&again), ["part"]);
        assert_eq!(
            kinds_in(&model),
            [
                (TailKind::Reasoning, "weighing the options".to_owned()),
                (TailKind::Text, "the answer".to_owned()),
            ]
        );
    }

    #[test]
    fn an_early_text_final_that_equals_what_streamed_changes_nothing() {
        let mut model = replying(0);
        model.at(1_000);
        event(
            &mut model,
            Some(7),
            &text_part("msg_a", "prt_t", "", &announced("1000")),
        );
        model.at(2_000);
        event(&mut model, None, &delta("msg_a", "prt_t", "the ", 0));
        event(&mut model, None, &delta("msg_a", "prt_t", "answer", 4));
        let before = tail(&model);
        let ended = r#","time":{"start":1000,"end":2100}"#;
        for seq in [8, 9] {
            let whole = event(
                &mut model,
                Some(seq),
                &text_part("msg_a", "prt_t", "the answer", ended),
            );
            assert_eq!(
                kinds(&whole),
                ["part"],
                "final {seq}: an entry would say nothing new"
            );
            assert_eq!(tail(&model), before);
        }
    }

    /* —— cleared off home —— */

    fn cleared(model: &Model, id: &str) -> Option<f64> {
        model.entry(&format!("desk:{id}")).unwrap().cleared
    }

    /// a finished turn on `ses_1`, idle again, its done need open.
    fn done_thread() -> Model {
        let mut model = Model::new();
        model.at(1000);
        event(&mut model, None, &updated("ses_1", 100, None));
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "stop");
        idle(&mut model, "ses_1");
        model.drain();
        model
    }

    #[test]
    fn clearing_a_thread_that_finished_before_the_start_empties_its_badge_and_it_does_not_lead() {
        // the store kept the done need; this boxbox never saw the turn, so the thread has no newest message
        let restored = Need::new(
            "done:desk:ses_1:msg_a".into(),
            NeedKind::Done,
            "desk:ses_1",
            5,
            "w is done".into(),
            "ok",
        );
        let mut model = Model::restore(
            Needs::restore(vec![restored], vec![]),
            Reads::default(),
            Clears::default(),
            Vec::new(),
        );
        model.at(1000);
        model.host_read(host_read_of(
            "ep",
            5,
            &[info("ses_1", 100, None), info("ses_2", 200, None)],
        ));
        assert_eq!(order(&model)[0], "desk:ses_1", "its open done leads");
        let (_, answers) = model.clear(&["desk:ses_1".into()], &phone());
        assert!(answers[0].1.is_ok());
        assert!(model.needs_open().is_empty(), "the badge is empty");
        assert_eq!(
            order(&model),
            ["desk:ses_2", "desk:ses_1"],
            "cleared goes last"
        );
    }

    #[test]
    fn a_cleared_thread_with_a_need_that_stays_does_not_lead_the_order() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".into()], &phone());
        // a review need stays after a clear, and a newer thread arrives
        model.raise(
            Need::new(
                "review:desk:ses_1".into(),
                NeedKind::Review,
                "desk:ses_1",
                9,
                "r".into(),
                "ok",
            ),
            None,
        );
        event(&mut model, None, &updated("ses_2", 50, None));
        assert_eq!(order(&model).last().copied(), Some("desk:ses_1"));
    }

    #[test]
    fn clearing_a_thread_takes_it_off_home_in_the_entry_every_device_gets() {
        let mut model = done_thread();
        assert_eq!(model.needs_open().len(), 1, "done, waiting to be seen");
        let (changes, answers) = model.clear(&["desk:ses_1".into()], &phone());
        assert!(answers[0].1.is_ok());
        assert_eq!(kinds(&changes), ["thread"]);
        let Change::Thread { thread: session } = &changes[0] else {
            unreachable!()
        };
        assert_eq!(
            session.cleared,
            Some(100.0),
            "the mark is the daemon's updated"
        );
        assert!(
            session.needs.is_empty(),
            "a dismissed done is served, not left in the badge"
        );
        let told = told(&mut model);
        assert!(told.contains(&"cleared desk:ses_1".to_owned()), "{told:?}");
    }

    #[test]
    fn a_cleared_thread_comes_back_when_the_daemons_clock_moves_past_the_mark() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".into()], &phone());
        model.drain();
        let changes = event(&mut model, None, &updated("ses_1", 100, None));
        let Change::Thread { thread: session } = &changes[0] else {
            unreachable!()
        };
        assert_eq!(
            session.cleared,
            Some(100.0),
            "an update that moved nothing keeps it cleared"
        );
        let changes = event(&mut model, None, &updated("ses_1", 101, None));
        let Change::Thread { thread: session } = &changes[0] else {
            unreachable!()
        };
        assert_eq!(session.cleared, None);
        assert_eq!(told(&mut model), ["uncleared desk:ses_1"]);
    }

    #[test]
    fn a_cleared_thread_that_starts_a_turn_comes_back_and_stays_back() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".into()], &phone());
        model.drain();
        let changes = event(
            &mut model,
            None,
            &status("ses_1", r#"{"type":"busy","since":5}"#),
        );
        let Change::Thread { thread: session } = &changes[0] else {
            unreachable!()
        };
        assert_eq!(session.cleared, None);
        idle(&mut model, "ses_1");
        assert_eq!(
            cleared(&model, "ses_1"),
            None,
            "its turn ending does not clear it again"
        );
        assert_eq!(
            told(&mut model)
                .iter()
                .filter(|t| t.starts_with("uncleared"))
                .count(),
            1
        );
    }

    #[test]
    fn a_cleared_thread_that_asks_comes_back() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".into()], &phone());
        let changes = event(
            &mut model,
            None,
            r#"{"id":"e","type":"question.asked","properties":{"id":"que_1","sessionID":"ses_1","questions":[{"question":"which?","header":"g","options":[]}]}}"#,
        );
        let session = changes.iter().find_map(|c| match c {
            Change::Thread { thread: session } => Some(session),
            _ => None,
        });
        assert_eq!(session.unwrap().cleared, None);
        assert_eq!(cleared(&model, "ses_1"), None);
    }

    #[test]
    fn a_working_thread_a_waiting_thread_a_subagent_and_a_stranger_are_not_cleared() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_work", 1, None));
        event(&mut model, None, &updated("ses_ask", 2, None));
        event(&mut model, None, &updated("ses_kid", 3, Some("ses_work")));
        busy(&mut model, "ses_work");
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"question.asked","properties":{"id":"que_1","sessionID":"ses_ask","questions":[]}}"#,
        );
        let keys: Vec<String> = ["desk:ses_work", "desk:ses_ask", "desk:ses_kid", "desk:nope"]
            .map(String::from)
            .into();
        let (_, answers) = model.clear(&keys, &phone());
        let answers: Vec<_> = answers.into_iter().map(|(_, a)| a).collect();
        assert_eq!(
            answers,
            [
                Err(ClearRefused::Working),
                Err(ClearRefused::Asking),
                Err(ClearRefused::Subagent),
                Err(ClearRefused::NoSuchSession)
            ]
        );
        assert!(model.clears.is_empty());
    }

    #[test]
    fn a_thread_parked_on_agents_at_work_is_working_and_is_not_cleared() {
        // the window reads it as working (its agents are its work), so the clear the window never offers is refused here
        // too: a stale tab or a script must not hide a thread whose agents are mid-task
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_p", 1, None));
        event(
            &mut model,
            None,
            &status(
                "ses_p",
                r#"{"type":"idle","since":9,"parked":{"agents":2,"jobs":0}}"#,
            ),
        );
        let (_, answers) = model.clear(&["desk:ses_p".into()], &phone());
        assert_eq!(answers[0].1, Err(ClearRefused::Working));
        assert!(model.clears.is_empty());
    }

    #[test]
    fn a_parked_thread_can_be_cleared() {
        let mut model = Model::new();
        event(&mut model, None, &updated("ses_p", 1, None));
        event(
            &mut model,
            None,
            &status(
                "ses_p",
                r#"{"type":"idle","since":9,"parked":{"agents":0,"jobs":1}}"#,
            ),
        );
        let (_, answers) = model.clear(&["desk:ses_p".into()], &phone());
        assert!(answers[0].1.is_ok());
        assert_eq!(cleared(&model, "ses_p"), Some(1.0));
    }

    #[test]
    fn archiving_takes_a_thread_out_of_the_fleet_with_its_mark() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".into()], &phone());
        model.drain();
        let archived = r#"{"id":"e","type":"session.updated","properties":{"sessionID":"ses_1","info":{"id":"ses_1","slug":"s","projectID":"/w","directory":"/w","title":"t","version":"0","source":"cmx2","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1,"updated":100,"archived":200}}}}"#;
        let changes = event(&mut model, None, archived);
        assert!(
            kinds(&changes).contains(&"thread.removed"),
            "{:?}",
            kinds(&changes)
        );
        assert!(model.entry("desk:ses_1").is_none());
        assert!(order(&model).is_empty());
        assert!(model.clears.is_empty());
        assert!(told(&mut model).contains(&"uncleared desk:ses_1".to_owned()));
    }

    #[test]
    fn a_host_read_that_finds_a_cleared_thread_touched_since_forgets_the_mark() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".into()], &phone());
        model.drain();
        model.host_read(host_read_of("ep", 5, &[info("ses_1", 100, None)]));
        assert_eq!(
            cleared(&model, "ses_1"),
            Some(100.0),
            "nothing happened: still cleared"
        );
        model.host_read(host_read_of("ep", 6, &[info("ses_1", 250, None)]));
        assert_eq!(cleared(&model, "ses_1"), None);
        assert!(told(&mut model).contains(&"uncleared desk:ses_1".to_owned()));
    }

    #[test]
    fn a_thread_opened_from_history_joins_the_fleet_once() {
        let mut model = Model::new();
        let old = raw(&info("ses_old", 5, None)).unwrap();
        let changes = model.adopt("desk", &old).unwrap();
        assert_eq!(kinds(&changes), ["thread", "order"]);
        assert!(model.entry("desk:ses_old").is_some());
        // opened again: still one thread, refreshed from the daemon's answer
        model.adopt("desk", &old).unwrap();
        assert_eq!(model.adopted_keys(), ["desk:ses_old"]);
        // one the daemon's newest listing holds is left as it is
        let mut other = Model::new();
        other.host_read(host_read_of("ep", 5, &[info("ses_new", 9, None)]));
        assert!(
            other
                .adopt("desk", &raw(&info("ses_new", 9, None)).unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_thread_opened_from_history_survives_the_host_being_read_again() {
        let mut model = Model::new();
        model.host_read(host_read_of("ep", 5, &[info("ses_new", 900, None)]));
        model
            .adopt("desk", &raw(&info("ses_old", 5, None)).unwrap())
            .unwrap();
        // a reconnect, then a new epoch: the daemon's newest listing never holds it
        for (epoch, seq) in [("ep", 6), ("other", 1)] {
            let changes = model.host_read(host_read_of(epoch, seq, &[info("ses_new", 901, None)]));
            assert!(
                model.entry("desk:ses_old").is_some(),
                "gone after the read in {epoch}"
            );
            let keys: Vec<&str> = threads_of(&changes)
                .iter()
                .map(|s| s.key.as_str())
                .collect();
            assert!(
                keys.contains(&"desk:ses_old"),
                "the reset a client applies keeps it: {keys:?}"
            );
        }
        assert_eq!(model.adopted, ["desk:ses_old"]);
    }

    #[test]
    fn an_adoption_is_told_to_the_store_and_so_is_everything_that_ends_it() {
        let mut model = Model::new();
        let old = raw(&info("ses_old", 5, None)).unwrap();
        model.adopt("desk", &old).unwrap();
        assert_eq!(told(&mut model), ["adopted desk:ses_old"]);
        // a read that carries it over says nothing: the store keeps it
        model.host_read(host_read_of("ep", 5, &[info("ses_new", 9, None)]));
        assert!(
            !told(&mut model)
                .iter()
                .any(|e| e.contains("adopted desk:ses_old"))
        );
        // a read whose listing holds it makes it ordinary: the store forgets it
        model.host_read(host_read_of("ep", 6, &[info("ses_old", 5, None)]));
        assert!(told(&mut model).contains(&"unadopted desk:ses_old".to_owned()));
    }

    #[test]
    fn a_thread_the_store_kept_is_held_again_at_its_hosts_first_read_only() {
        let kept = raw(&info("ses_old", 5, None)).unwrap();
        let mut model = Model::restore(
            Needs::default(),
            Reads::default(),
            Clears::default(),
            vec![
                ("desk:ses_old".into(), kept),
                (
                    "attic:ses_far".into(),
                    raw(&info("ses_far", 6, None)).unwrap(),
                ),
            ],
        );
        assert!(
            model.entry("desk:ses_old").is_none(),
            "nothing before its host is read"
        );
        let changes = model.host_read(host_read_of("ep", 5, &[info("ses_new", 9, None)]));
        assert!(model.entry("desk:ses_old").is_some());
        assert!(
            model.entry("attic:ses_far").is_none(),
            "another host's waits for its own read"
        );
        assert!(threads_of(&changes).iter().any(|s| s.key == "desk:ses_old"));
        assert_eq!(model.adopted, ["desk:ses_old"]);
    }

    #[test]
    fn a_thread_the_store_kept_that_was_archived_meanwhile_is_forgotten() {
        let archived =
            info("ses_old", 5, None).replace(r#""updated":5"#, r#""updated":5,"archived":9"#);
        let mut model = Model::restore(
            Needs::default(),
            Reads::default(),
            Clears::default(),
            vec![("desk:ses_old".into(), raw(&archived).unwrap())],
        );
        model.host_read(host_read_of("ep", 5, &[]));
        assert!(model.entry("desk:ses_old").is_none());
        assert!(told(&mut model).contains(&"unadopted desk:ses_old".to_owned()));
    }

    #[test]
    fn a_thread_archived_while_boxbox_was_down_is_dropped_when_the_daemon_says_so() {
        // as the store really keeps it: the info from the adoption, before the archive
        let adopted = raw(&info("ses_old", 5, None)).unwrap();
        let mut model = Model::restore(
            Needs::default(),
            Reads::default(),
            Clears::default(),
            vec![("desk:ses_old".into(), adopted)],
        );
        assert_eq!(model.adopted_keys(), ["desk:ses_old"]);
        // the confirm lands before the host is read: it never joins
        model.unadopt("desk:ses_old");
        model.host_read(host_read_of("ep", 5, &[info("ses_new", 9, None)]));
        assert!(model.entry("desk:ses_old").is_none());
        assert!(model.adopted_keys().is_empty());
        assert!(told(&mut model).contains(&"unadopted desk:ses_old".to_owned()));
    }

    #[test]
    fn a_confirm_that_lands_after_the_read_takes_the_held_thread_out() {
        let adopted = raw(&info("ses_old", 5, None)).unwrap();
        let mut model = Model::restore(
            Needs::default(),
            Reads::default(),
            Clears::default(),
            vec![("desk:ses_old".into(), adopted)],
        );
        model.host_read(host_read_of("ep", 5, &[info("ses_new", 9, None)]));
        assert!(model.entry("desk:ses_old").is_some());
        let changes = model.unadopt("desk:ses_old");
        assert!(kinds(&changes).contains(&"thread.removed"));
        assert!(model.entry("desk:ses_old").is_none());
        assert!(model.adopted_keys().is_empty());
    }

    #[test]
    fn a_confirmed_thread_is_refreshed_from_the_daemon_and_kept() {
        let stored = raw(&info("ses_old", 5, None)).unwrap();
        let mut model = Model::restore(
            Needs::default(),
            Reads::default(),
            Clears::default(),
            vec![("desk:ses_old".into(), stored)],
        );
        model.host_read(host_read_of("ep", 5, &[info("ses_new", 9, None)]));
        model.drain();
        // renamed and touched while boxbox was down: the daemon's read replaces the stored info
        let fresh = raw(&info("ses_old", 77, None)).unwrap();
        let changes = model.adopt("desk", &fresh).unwrap();
        assert!(kinds(&changes).contains(&"thread"));
        assert!((model.entry("desk:ses_old").unwrap().updated - 77.0).abs() < f64::EPSILON);
        assert_eq!(model.adopted_keys(), ["desk:ses_old"]);
        assert!(told(&mut model).contains(&"adopted desk:ses_old".to_owned()));
    }

    #[test]
    fn the_session_cap_never_drops_an_adopted_thread_or_one_on_a_stage() {
        let mut model = Model::new();
        model.at(1000);
        model
            .adopt("desk", &raw(&info("ses_adopted", 1, None)).unwrap())
            .unwrap();
        model.looking(vec![Looking {
            device: "d".into(),
            class: String::new(),
            thread: Some("desk:ses_staged".into()),
            until: i64::MAX,
        }]);
        let mut sessions = vec![info("ses_staged", 2, None)];
        sessions
            .extend((0..MAX_SESSIONS).map(|n| info(&format!("ses_{n:04}"), 100 + n as u64, None)));
        model.host_read(host_read_of("ep", 5, &sessions));
        assert!(model.sessions.len() <= MAX_SESSIONS + 1);
        assert!(
            model.entry("desk:ses_adopted").is_some(),
            "adopted, and the oldest"
        );
        assert!(
            model.entry("desk:ses_staged").is_some(),
            "on a stage, and the second oldest"
        );
    }

    #[test]
    fn a_host_that_holds_an_adopted_thread_after_all_makes_it_ordinary_again() {
        let mut model = Model::new();
        model
            .adopt("desk", &raw(&info("ses_old", 5, None)).unwrap())
            .unwrap();
        model.host_read(host_read_of("ep", 5, &[info("ses_old", 5, None)]));
        assert!(model.entry("desk:ses_old").is_some());
        assert!(
            model.adopted.is_empty(),
            "the newest listing carries it now"
        );
    }

    #[test]
    fn adopted_threads_are_capped_oldest_first_and_never_the_one_on_a_stage() {
        let mut model = Model::new();
        for n in 0..MAX_ADOPTED {
            model
                .adopt(
                    "desk",
                    &raw(&info(&format!("ses_{n:02}"), 5, None)).unwrap(),
                )
                .unwrap();
        }
        // a device has the oldest adoption open
        model.looking(vec![Looking {
            device: "d".into(),
            class: String::new(),
            thread: Some("desk:ses_00".into()),
            until: i64::MAX,
        }]);
        let changes = model
            .adopt("desk", &raw(&info("ses_new", 5, None)).unwrap())
            .unwrap();
        assert!(kinds(&changes).contains(&"thread.removed"));
        assert!(model.entry("desk:ses_00").is_some(), "on a stage: kept");
        assert!(
            model.entry("desk:ses_01").is_none(),
            "the oldest idle one goes"
        );
        assert!(model.entry("desk:ses_new").is_some());
        assert_eq!(model.adopted.len(), MAX_ADOPTED);
    }

    #[test]
    fn an_archived_thread_is_not_adopted() {
        let mut model = Model::new();
        let archived =
            info("ses_gone", 5, None).replace(r#""updated":5"#, r#""updated":5,"archived":9"#);
        let changes = model.adopt("desk", &raw(&archived).unwrap()).unwrap();
        assert!(changes.is_empty());
        assert!(model.entry("desk:ses_gone").is_none());
        assert!(model.adopted.is_empty());
    }

    #[test]
    fn cleared_threads_rank_below_every_other_so_the_orders_cap_never_drops_a_live_one() {
        let mut model = Model::new();
        let sessions: Vec<String> = (0..=MAX_ORDER)
            .map(|n| info(&format!("ses_{n:03}"), 1000 + n as u64, None))
            .collect();
        model.host_read(host_read_of("ep", 5, &sessions));
        assert_eq!(order(&model).len(), MAX_ORDER);
        assert_eq!(order(&model)[0], "desk:ses_300", "the newest leads");
        assert!(
            !order(&model).contains(&"desk:ses_000"),
            "the oldest is past the cap"
        );
        model.clear(&["desk:ses_300".into()], &phone());
        assert!(
            order(&model).contains(&"desk:ses_000"),
            "the cleared newest gave its place to the oldest live one"
        );
        assert!(!order(&model).contains(&"desk:ses_300"));
    }

    #[test]
    fn the_order_is_sent_only_when_it_moves() {
        let mut model = Model::new();
        model.host_read(host_read_of(
            "ep",
            5,
            &[info("ses_1", 10, None), info("ses_2", 20, None)],
        ));
        assert_eq!(order(&model), ["desk:ses_2", "desk:ses_1"]);
        let mut changes = Vec::new();
        model.reorder(&mut changes);
        assert!(changes.is_empty(), "the order held is still the order");
        // a clear ranks the thread below every other, so the order moves and is sent once
        model.clear(&["desk:ses_2".into()], &phone());
        assert_eq!(order(&model), ["desk:ses_1", "desk:ses_2"]);
        let mut changes = Vec::new();
        model.reorder(&mut changes);
        assert!(changes.is_empty(), "already sent when it moved");
    }

    #[test]
    fn history_marks_a_row_cleared_only_while_the_mark_holds() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".into()], &phone());
        let rows = [
            ("desk:ses_1".to_owned(), 100.0),
            ("desk:ses_1".to_owned(), 101.0),
            ("desk:other".to_owned(), 1.0),
        ];
        assert_eq!(model.cleared_among(&rows), [true, false, false]);
    }

    #[test]
    fn a_host_shows_the_project_roots_and_directories_its_sessions_work_in() {
        let mut model = Model::new();
        let worktree = info("ses_wt", 9, None)
            .replace(r#""projectID":"/w""#, r#""projectID":"/work/app""#)
            .replace(r#""directory":"/w""#, r#""directory":"/work/app-fix""#);
        model.host_read(host_read_of("ep", 5, &[info("ses_a", 8, None), worktree]));
        let places = model.places("desk");
        assert_eq!(
            places,
            ["/w", "/work/app", "/work/app-fix"]
                .into_iter()
                .map(String::from)
                .collect()
        );
        assert!(
            model.places("laptop").is_empty(),
            "another host shows nothing of this one's"
        );
    }

    /// a model on a fresh install: no colours kept, and it gives them.
    fn colouring() -> Model {
        let mut model = Model::restored(
            Needs::default(),
            Reads::default(),
            Clears::default(),
            Vec::new(),
            Colours::assigning(),
        );
        model.at(1_000);
        model
    }

    /// a session's info in `project`, working in `directory`.
    fn info_at(id: &str, project: &str, directory: &str) -> String {
        info(id, 5, None)
            .replace(
                r#""projectID":"/w""#,
                &format!(r#""projectID":"{project}""#),
            )
            .replace(
                r#""directory":"/w""#,
                &format!(r#""directory":"{directory}""#),
            )
    }

    /// the `n`th root under /work whose hash on desk names `slot`.
    fn root_hashing_to(slot: u8, n: usize) -> String {
        (0..)
            .map(|i| format!("/work/r{i}"))
            .filter(|root| colours::hashed("desk", root) == slot)
            .nth(n)
            .unwrap()
    }

    fn hash_colour(root: &str) -> String {
        colours::NAMES[usize::from(colours::hashed("desk", root))].to_owned()
    }

    fn given(colours: &[wire::RepoColour]) -> Vec<(String, String)> {
        colours
            .iter()
            .map(|colour| (colour.root.clone(), colour.auto.clone()))
            .collect()
    }

    #[test]
    fn a_first_read_gives_the_busiest_repo_its_hash_colour_and_moves_the_one_that_clashed() {
        let mut model = colouring();
        // two repos whose hashes name cobalt; the one that sorts first has fewer threads
        let (mut quiet, mut busy) = (root_hashing_to(3, 0), root_hashing_to(3, 1));
        if quiet > busy {
            std::mem::swap(&mut quiet, &mut busy);
        }
        let worktree = format!("{busy}-fix");
        let changes = model.host_read(host_read_of(
            "ep",
            5,
            &[
                info_at("ses_q", &quiet, &quiet),
                info_at("ses_b1", &busy, &busy),
                info_at("ses_b2", &busy, &worktree),
                info_at("ses_b3", &busy, &busy),
                // threads in the root folder are a repo like any other
                info_at("ses_s1", "/", "/"),
                info_at("ses_s2", "/", "/"),
            ],
        ));
        let colours = model.assign_colours(&changes);
        let scratch = if hash_colour("/") == "cobalt" {
            "green".to_owned()
        } else {
            hash_colour("/")
        };
        let given = given(&colours);
        assert_eq!(
            given[..2],
            [
                (busy.clone(), "cobalt".to_owned()),
                ("/".to_owned(), scratch.clone())
            ],
            "most threads first"
        );
        assert_eq!(given.len(), 3, "a worktree's thread is its repo's");
        assert_eq!(given[2].0, quiet);
        assert!(
            given[2].1 != "cobalt" && given[2].1 != scratch,
            "the quieter repo moves off the colours taken"
        );
        assert_eq!(model.colour_list().len(), 3);
        assert_eq!(
            model
                .drain()
                .iter()
                .filter(|e| matches!(e, Effect::Colour(_)))
                .count(),
            3,
            "each is written at once"
        );
    }

    #[test]
    fn a_read_breaks_a_tie_in_threads_by_root() {
        let mut model = colouring();
        let (a, b) = (root_hashing_to(8, 0), root_hashing_to(8, 1));
        let (first, second) = if a < b { (a, b) } else { (b, a) };
        let changes = model.host_read(host_read_of(
            "ep",
            5,
            &[
                info_at("ses_2", &second, &second),
                info_at("ses_1", &first, &first),
            ],
        ));
        let given = given(&model.assign_colours(&changes));
        assert_eq!(given[0], (first, "magenta".to_owned()));
        assert_eq!(given[1], (second, "green".to_owned()));
    }

    #[test]
    fn a_repo_already_given_a_colour_keeps_it_on_the_next_read() {
        let mut model = colouring();
        let changes = model.host_read(host_read_of(
            "ep",
            5,
            &[info_at("ses_1", "/work/api", "/work/api")],
        ));
        assert_eq!(model.assign_colours(&changes).len(), 1);
        let again = model.host_read(host_read_of(
            "ep2",
            6,
            &[info_at("ses_1", "/work/api", "/work/api")],
        ));
        assert!(model.assign_colours(&again).is_empty());
    }

    #[test]
    fn two_sessions_of_a_new_repo_arriving_together_give_it_one_colour() {
        let mut model = colouring();
        let first = event(&mut model, Some(1), &updated_in("ses_1", 2, "/w"));
        let second = event(&mut model, Some(2), &updated_in("ses_2", 2, "/w-other"));
        // the actor takes one message at a time, the first in full before the second
        let colours: Vec<_> = model
            .assign_colours(&first)
            .into_iter()
            .chain(model.assign_colours(&second))
            .collect();
        assert_eq!(given(&colours), vec![("/w".to_owned(), hash_colour("/w"))]);
        // and two in one read are one repo too
        let mut model = colouring();
        let changes = model.host_read(host_read_of(
            "ep",
            5,
            &[
                info_at("ses_1", "/work/api", "/work/api"),
                info_at("ses_2", "/work/api", "/work/api-wt"),
            ],
        ));
        assert_eq!(model.assign_colours(&changes).len(), 1);
    }

    #[test]
    fn a_host_read_marks_its_repos_used_at_most_once_a_day() {
        let mut model = colouring();
        let read = |model: &mut Model, epoch: &str| {
            let changes = model.host_read(host_read_of(
                epoch,
                5,
                &[info_at("ses_1", "/work/api", "/work/api")],
            ));
            model.assign_colours(&changes);
            model
                .drain()
                .iter()
                .filter(|e| matches!(e, Effect::Colour(_)))
                .count()
        };
        assert_eq!(read(&mut model, "ep1"), 1, "given");
        model.at(1_000 + 60_000);
        assert_eq!(
            read(&mut model, "ep2"),
            0,
            "a reconnect within the day writes nothing"
        );
        model.at(1_000 + 24 * 60 * 60 * 1000);
        assert_eq!(
            read(&mut model, "ep3"),
            1,
            "a day on, its last use is written"
        );
    }

    #[test]
    fn a_session_change_marks_its_repo_used_on_a_host_that_never_reconnects() {
        let mut model = colouring();
        let given = event(&mut model, Some(1), &updated("ses_1", 2, None));
        assert_eq!(model.assign_colours(&given).len(), 1);
        model.drain();
        let touch = |model: &mut Model, at: i64, updated_at: u64| {
            model.at(at);
            let changes = event(model, None, &updated("ses_1", updated_at, None));
            assert!(model.assign_colours(&changes).is_empty());
            model
                .drain()
                .into_iter()
                .filter_map(|e| match e {
                    Effect::Colour(colours::Write::Put { at, .. }) => Some(at),
                    _ => None,
                })
                .collect::<Vec<i64>>()
        };
        let day = 24 * 60 * 60 * 1000;
        assert!(
            touch(&mut model, 1_000 + 60_000, 3).is_empty(),
            "within the day: no write"
        );
        assert_eq!(
            touch(&mut model, 1_000 + day, 4),
            vec![1_000 + day],
            "a day on: its last use"
        );
        assert!(touch(&mut model, 2_000 + day, 5).is_empty());
        // so a restart over the cap, before any host read, keeps it
        let kept: Vec<colours::Kept> = std::iter::once((
            "desk:/w".to_owned(),
            r#"{"auto":"teal","chosen":null}"#.to_owned(),
            1_000 + day,
        ))
        .chain((0..colours::MAX_COLOURS).map(|n| {
            (
                format!("desk:/idle/{n}"),
                r#"{"auto":"teal","chosen":null}"#.to_owned(),
                500 + i64::try_from(n).unwrap(),
            )
        }))
        .collect();
        let (restored, dropped) = Colours::restore(kept);
        assert!(restored.has("desk", "/w"));
        assert_eq!(dropped, vec!["desk:/idle/0".to_owned()]);
    }

    #[test]
    fn a_model_that_does_not_give_colours_journals_none() {
        let mut model = Model::new();
        let changes = event(&mut model, Some(1), &updated("ses_1", 2, None));
        assert!(model.assign_colours(&changes).is_empty());
        assert!(model.colour_list().is_empty());
    }

    #[test]
    fn a_choice_journals_the_repo_colour_and_automatic_brings_back_the_given_one() {
        let mut model = colouring();
        let changes = model.host_read(host_read_of(
            "ep",
            5,
            &[info_at("ses_1", "/work/api", "/work/api")],
        ));
        let given = model.assign_colours(&changes);
        let auto = &given[0];
        let (chosen, changes) = model
            .choose_colour("desk", "/work/api", colours::slot("sunset"))
            .unwrap();
        assert_eq!(chosen.chosen.as_deref(), Some("sunset"));
        assert_eq!(
            chosen.auto, auto.auto,
            "a choice keeps what was given under it"
        );
        assert!(changes, "it moved");
        let (back, changes) = model.choose_colour("desk", "/work/api", None).unwrap();
        assert_eq!(&back, auto);
        assert!(changes);
        let (_, nothing) = model.choose_colour("desk", "/work/api", None).unwrap();
        assert!(!nothing, "the same choice again moves nothing");
        assert_eq!(
            model
                .drain()
                .iter()
                .filter(|e| matches!(e, Effect::Colour(_)))
                .count(),
            4,
            "one write each, the choice that moved nothing too: it may retry a dropped write"
        );
        assert!(
            matches!(
                model.choose_colour("desk", "/work/never", colours::slot("teal")),
                Err(ColourRefused::UnknownRepo)
            ),
            "a repo with no colour and no session"
        );
        assert!(
            matches!(
                model.choose_colour("laptop", "/work/api", colours::slot("teal")),
                Err(ColourRefused::UnknownRepo)
            ),
            "repos never merge across hosts"
        );
    }
    fn resets_in(changes: &[Change]) -> Vec<&str> {
        changes
            .iter()
            .filter_map(|c| match c {
                Change::ThreadReset { key } => Some(key.as_str()),
                _ => None,
            })
            .collect()
    }

    fn newest_asked(model: &mut Model) -> Vec<String> {
        model
            .drain()
            .into_iter()
            .filter_map(|e| match e {
                Effect::ReadTail(request) if request.newest => Some(request.key),
                _ => None,
            })
            .collect()
    }

    fn busy_read(epoch: &str, seq: u64, sessions: &[String], busy: &[&str]) -> HostRead {
        let mut read = host_read_of(epoch, seq, sessions);
        read.statuses.data = busy
            .iter()
            .map(|id| ((*id).to_owned(), raw(r#"{"type":"busy"}"#).unwrap()))
            .collect();
        read
    }

    #[test]
    fn the_quiet_re_read_resets_only_threads_whose_transcript_revision_moved_or_is_unknown() {
        let mut model = Model::new();
        model.host_read(host_read_of(
            "ep",
            5,
            &[
                info_rev("ses_1", 1, 3),
                info_rev("ses_2", 1, 7),
                info("ses_3", 1, None),
                info_rev("ses_5", 1, 2),
            ],
        ));
        model.drain();
        // the gap: ses_2 was written, ses_1 held still, ses_3 has no revision, ses_4 is new, ses_5 went
        let changes = model.host_read(host_read_of(
            "ep",
            20,
            &[
                info_rev("ses_1", 1, 3),
                info_rev("ses_2", 2, 9),
                info("ses_3", 1, None),
                info_rev("ses_4", 1, 0),
            ],
        ));
        assert_eq!(resets_in(&changes), ["desk:ses_2", "desk:ses_3"]);
        assert!(
            changes
                .iter()
                .any(|c| matches!(c, Change::ThreadRemoved { key } if key == "desk:ses_5")),
            "a thread gone in the gap is removed"
        );
        assert_eq!(model.srev("desk:ses_2"), Some(9));
        assert_eq!(
            model.srev("desk:ses_4"),
            Some(0),
            "a new thread starts from its listing"
        );
        assert!(newest_asked(&mut model).is_empty(), "nothing streamed");
        // a gap where nothing moved resets only the thread no revision can vouch for
        let changes = model.host_read(host_read_of(
            "ep",
            30,
            &[
                info_rev("ses_1", 1, 3),
                info_rev("ses_2", 2, 9),
                info("ses_3", 1, None),
                info_rev("ses_4", 1, 0),
            ],
        ));
        assert_eq!(resets_in(&changes), ["desk:ses_3"]);
    }

    #[test]
    fn srev_moves_with_journaled_events_and_session_infos_and_never_from_a_read_ahead_of_the_stream()
     {
        let mut model = Model::new();
        model.host_read(host_read_of("ep", 5, &[info_rev("ses_1", 1, 3)]));
        assert_eq!(model.srev("desk:ses_1"), Some(3));
        // a message event carries the revision after its write
        let message = r#"{"id":"e","type":"message.updated","properties":{"sessionID":"ses_1","info":{"id":"m1","sessionID":"ses_1","role":"assistant","time":{"created":10}},"rev":4}}"#;
        event(&mut model, Some(6), message);
        assert_eq!(model.srev("desk:ses_1"), Some(4));
        // a session info from a stream without rev=1 leaves it
        event(&mut model, Some(7), &updated("ses_1", 2, None));
        assert_eq!(model.srev("desk:ses_1"), Some(4));
        // a tail read stamped past what the stream applied does not move it
        let read = translate::tail(
            "ses_1".into(),
            Stamp {
                epoch: "ep".into(),
                seq: 50,
            },
            Some(11),
            b"[]",
        )
        .unwrap();
        model.tail("desk", read);
        assert_eq!(model.srev("desk:ses_1"), Some(4));
    }

    #[test]
    fn a_thread_busy_across_a_gap_whose_revision_held_has_its_newest_messages_journaled_whole() {
        let mut model = Model::new();
        model.host_read(busy_read("ep", 5, &[info_rev("ses_1", 1, 3)], &["ses_1"]));
        model.drain();
        let changes = model.host_read(busy_read("ep", 20, &[info_rev("ses_1", 1, 3)], &["ses_1"]));
        assert!(
            resets_in(&changes).is_empty(),
            "the revision held: no reset"
        );
        assert_eq!(newest_asked(&mut model), ["desk:ses_1"]);
        // the read: the prompt, and the answer still streaming its text
        let body = format!(
            "[{},{}]",
            read_message("u1", "user", &[read_part("u1", "p0", "text", "go", "")]),
            read_message(
                "a1",
                "assistant",
                &[read_part("a1", "p1", "text", "hello wor", "")]
            ),
        );
        let stamp = Stamp {
            epoch: "ep".into(),
            seq: 20,
        };
        let read =
            translate::tail("ses_1".into(), stamp.clone(), Some(3), body.as_bytes()).unwrap();
        let changes = model.newest_read("desk", read);
        let streamed = changes.iter().find_map(|c| match c {
            Change::Part {
                upstream: None,
                part: Part::Text(p),
                ..
            } if p.id == "p1" => p.text.clone(),
            _ => None,
        });
        assert_eq!(
            streamed.as_deref(),
            Some("hello wor"),
            "the part streaming across the gap comes whole"
        );
        assert!(changes.iter().all(|c| !matches!(
            c,
            Change::Message {
                upstream: Some(_),
                ..
            } | Change::Part {
                upstream: Some(_),
                ..
            }
        )));
        // asked again, and the transcript moved while it was read: the thread is reset instead
        model.host_read(busy_read("ep", 30, &[info_rev("ses_1", 1, 3)], &["ses_1"]));
        assert_eq!(newest_asked(&mut model), ["desk:ses_1"]);
        let read =
            translate::tail("ses_1".into(), stamp.clone(), Some(5), body.as_bytes()).unwrap();
        let changes = model.newest_read("desk", read);
        assert_eq!(resets_in(&changes), ["desk:ses_1"]);
        assert_eq!(model.srev("desk:ses_1"), Some(5));
        // and one that could not be read at all is reset too
        model.host_read(busy_read("ep", 40, &[info_rev("ses_1", 1, 5)], &["ses_1"]));
        newest_asked(&mut model);
        assert_eq!(
            resets_in(&model.newest_failed("desk:ses_1")),
            ["desk:ses_1"]
        );
    }

    #[test]
    fn the_model_comes_back_whole_from_its_rows() {
        let mut model = Model::new();
        model.host_read(busy_read(
            "ep",
            5,
            &[info_rev("ses_1", 1, 3), info_rev("ses_2", 1, 4)],
            &["ses_1"],
        ));
        model.tail_read(tail_read_of(
            "ep",
            5,
            &[read_message(
                "a1",
                "assistant",
                &[read_part("a1", "p1", "text", "done", "")],
            )],
        ));
        model.drain();
        let (threads, agents, asks) = model.held_keys();
        let rows = state::Rows {
            threads: threads
                .iter()
                .map(|k| (k.clone(), model.thread_state(k).unwrap(), model.srev(k)))
                .collect(),
            agents: agents
                .iter()
                .filter_map(|k| Some((k.clone(), model.agent_state(k)?)))
                .collect(),
            asks: asks
                .iter()
                .filter_map(|(a, i)| Some((a.clone(), model.ask_state(a, i)?)))
                .collect(),
            order: model.order_state(),
        };
        let mut back = Model::new();
        assert_eq!(back.resume(rows), 0);
        assert_eq!(
            serde_json::to_string(&back.snapshot()).unwrap(),
            serde_json::to_string(&model.snapshot()).unwrap()
        );
        for key in &threads {
            assert_eq!(back.thread_state(key), model.thread_state(key), "{key}");
        }
        assert_eq!(back.order_state(), model.order_state());
    }
    fn rss_kib() -> u64 {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0)
    }

    /// start-up on a large state (`docs/protocol.md`, section 16): 1,000
    /// threads, each with a full twelve-item tail of 280-character text, through
    /// their rows and back. `cargo test --release large_state -- --ignored --nocapture`.
    #[test]
    #[ignore = "a measurement, run by hand"]
    #[allow(clippy::too_many_lines, reason = "one measurement, start to end")]
    fn large_state_start_up_time_and_memory() {
        let text = "x".repeat(280);
        let mut model = Model::new();
        let infos: Vec<String> = (0..1000)
            .map(|n| info_rev(&format!("ses_{n:04}"), 1 + n, n))
            .collect();
        model.host_read(host_read_of("ep", 5, &infos));
        for n in 0..1000 {
            let messages: Vec<String> = (0..12)
                .map(|m| {
                    format!(
                        r#"{{"info":{{"id":"m{m}","sessionID":"ses_{n:04}","role":"assistant","time":{{"created":{m}}}}},"parts":[{{"id":"p{m}","sessionID":"ses_{n:04}","messageID":"m{m}","type":"text","text":"{text}"}}]}}"#
                    )
                })
                .collect();
            model.tail_read((
                format!("desk:ses_{n:04}"),
                Cursor {
                    epoch: "ep".into(),
                    seq: 5,
                },
                format!("[{}]", messages.join(",")),
            ));
        }
        model.drain();
        let (threads, agents, asks) = model.held_keys();
        let started = std::time::Instant::now();
        let rows = state::Rows {
            threads: threads
                .iter()
                .map(|k| (k.clone(), model.thread_state(k).unwrap(), model.srev(k)))
                .collect(),
            agents: agents
                .iter()
                .filter_map(|k| Some((k.clone(), model.agent_state(k)?)))
                .collect(),
            asks: asks
                .iter()
                .filter_map(|(a, i)| Some((a.clone(), model.ask_state(a, i)?)))
                .collect(),
            order: model.order_state(),
        };
        let bodies: Vec<String> = threads
            .iter()
            .map(|k| serde_json::to_string(&model.thread(k).unwrap()).unwrap())
            .collect();
        let encoded = started.elapsed();
        let bytes: usize = rows.threads.iter().map(|r| r.1.len()).sum::<usize>()
            + bodies.iter().map(String::len).sum::<usize>();
        // through sqlite: one batch written, the tables read back
        let dir = std::env::temp_dir().join(format!("boxbox-large-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut db = rusqlite::Connection::open(dir.join("boxbox.db")).unwrap();
        db.pragma_update(None, "journal_mode", "wal").unwrap();
        db.pragma_update(None, "synchronous", "normal").unwrap();
        crate::store::migrate_for_tests(&mut db);
        let writes = rows
            .threads
            .iter()
            .zip(&bodies)
            .map(|((key, state, srev), body)| {
                crate::fleet::persist::Write::Put(crate::fleet::persist::Row {
                    kind: "thread".into(),
                    key: key.clone(),
                    seq: 1,
                    whole: false,
                    v: 1,
                    rv: 1,
                    reset_seq: 0,
                    srev: *srev,
                    raised: None,
                    turn: None,
                    body: body.clone(),
                    model: Some(state.clone()),
                })
            })
            .collect();
        let batch = crate::fleet::persist::Batch {
            id: 1,
            epoch: "0123456789ab".into(),
            head: 1,
            reserved: 1_000_001,
            clean: true,
            gone_floor: 0,
            writes,
            graves: Vec::new(),
            cursors: Vec::new(),
            bytes,
        };
        let started = std::time::Instant::now();
        crate::fleet::persist::write(&mut db, &batch).unwrap();
        let committed = started.elapsed();
        let started = std::time::Instant::now();
        let stored = crate::fleet::persist::load(&db).unwrap();
        let resumed_rows = crate::fleet::persist::start(stored);
        let started_from_db = started.elapsed();
        assert_eq!(resumed_rows.how, crate::fleet::persist::How::Clean);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
        eprintln!(
            "large state: the batch of 1000 rows committed in {} ms; loaded and checked by encoder in {} ms",
            committed.as_millis(),
            started_from_db.as_millis()
        );
        drop(model);
        let before = rss_kib();
        let started = std::time::Instant::now();
        let mut back = Model::new();
        assert_eq!(back.resume(rows), 0);
        let mut bases = Vec::with_capacity(bodies.len());
        for body in &bodies {
            let thread: wire::Thread = serde_json::from_str(body).unwrap();
            assert_eq!(&serde_json::to_string(&thread).unwrap(), body);
            bases.push(thread);
        }
        let resumed = started.elapsed();
        let after = rss_kib();
        assert_eq!(back.session_count(), 1000);
        eprintln!(
            "large state: 1000 threads, {} kb of rows; encoded in {} ms; decoded, checked and resumed in {} ms; rss {} kb before, {} kb after (+{} kb)",
            bytes / 1024,
            encoded.as_millis(),
            resumed.as_millis(),
            before,
            after,
            after.saturating_sub(before)
        );
        drop(bases);
    }

    #[test]
    fn a_session_info_past_the_journaled_revision_resets_the_thread() {
        let mut model = Model::new();
        model.host_read(host_read_of("ep", 5, &[info_rev("ses_1", 1, 3)]));
        model.drain();
        // a message landed: its event carries the revision after it
        let message = r#"{"id":"e","type":"message.updated","properties":{"sessionID":"ses_1","info":{"id":"m1","sessionID":"ses_1","role":"assistant","time":{"created":10}},"rev":4}}"#;
        event(&mut model, Some(6), message);
        // the session info that follows says the same revision: nothing to read
        let changes = event(
            &mut model,
            Some(7),
            &format!(
                r#"{{"id":"e","type":"session.updated","properties":{{"sessionID":"ses_1","info":{}}}}}"#,
                info_rev("ses_1", 2, 4)
            ),
        );
        assert!(resets_in(&changes).is_empty());
        // a revert moved it with no transcript event: the journal does not hold that write
        let changes = event(
            &mut model,
            Some(8),
            &format!(
                r#"{{"id":"e","type":"session.updated","properties":{{"sessionID":"ses_1","info":{}}}}}"#,
                info_rev("ses_1", 3, 5)
            ),
        );
        assert_eq!(resets_in(&changes), ["desk:ses_1"]);
        assert_eq!(model.srev("desk:ses_1"), Some(5));
    }

    #[test]
    fn a_compact_replay_judges_a_session_info_s_revision_once_caught_up() {
        let mut model = Model::new();
        model.host_read(host_read_of("ep", 5, &[info_rev("ses_1", 1, 9)]));
        model.drain();
        let session = |updated: u64, rev: u64| {
            format!(
                r#"{{"id":"e","type":"session.updated","properties":{{"sessionID":"ses_1","info":{}}}}}"#,
                info_rev("ses_1", updated, rev)
            )
        };
        let part = |rev: u64| {
            format!(
                r#"{{"id":"e","type":"message.part.updated","properties":{{"sessionID":"ses_1","part":{{"id":"p1","sessionID":"ses_1","messageID":"m1","type":"text","text":"hi"}},"rev":{rev}}}}}"#
            )
        };
        // a thread working across a restart: part (rev 10, seq 100), session (rev 10, seq 101), part (rev 11,
        // seq 102); the compact replay sends 101 and 102 only
        model.source("desk", None, SourceEvent::Replaying);
        let mut changes = event(&mut model, Some(101), &session(2, 10));
        changes.extend(event(&mut model, Some(102), &part(11)));
        changes.extend(model.source("desk", None, SourceEvent::CaughtUp));
        assert!(
            resets_in(&changes).is_empty(),
            "nothing was missed: no reset"
        );
        assert_eq!(model.srev("desk:ses_1"), Some(11));
        // a revert during the replay: the info's revision no event reached
        model.source("desk", None, SourceEvent::Replaying);
        let mut changes = event(&mut model, Some(103), &session(3, 12));
        assert!(
            resets_in(&changes).is_empty(),
            "held until the replay is caught up"
        );
        changes.extend(model.source("desk", None, SourceEvent::CaughtUp));
        assert_eq!(resets_in(&changes), ["desk:ses_1"]);
        assert_eq!(model.srev("desk:ses_1"), Some(12));
    }

    /* —— finished work clearing itself (decisions 93 to 95) —— */

    const HOUR: i64 = 60 * 60 * 1000;

    /// `done_thread`, read on the phone through its reply at 1000.
    fn seen_thread() -> Model {
        let mut model = done_thread();
        model.read("desk:ses_1", &phone(), "msg_a", 100.0).unwrap();
        model.drain();
        model
    }

    fn sweep_at(model: &mut Model, at: i64) -> Swept {
        model.at(at);
        model.sweep().1
    }

    fn mode(model: &mut Model, auto_clear: AutoClear) {
        model.set_home(HomePrefs {
            auto_clear,
            ..HomePrefs::default()
        });
    }

    /// what `any3h` clears of a thread, with a first sweep an hour in to see it
    /// idle and a second ten hours in, well past every wait.
    fn cleared_late(model: &mut Model) -> Vec<String> {
        mode(model, AutoClear::Any3h);
        let mut cleared = sweep_at(model, 1000 + HOUR).cleared;
        cleared.extend(sweep_at(model, 1000 + 10 * HOUR).cleared);
        cleared
    }

    fn looking_now(model: &mut Model) {
        model.looking(vec![Looking {
            device: "mac".into(),
            class: "mac".into(),
            thread: None,
            until: i64::MAX,
        }]);
    }

    #[test]
    fn seen1h_clears_a_thread_an_hour_after_it_was_seen_through_its_newest() {
        let mut model = seen_thread();
        assert!(sweep_at(&mut model, 1000 + HOUR - 1).cleared.is_empty());
        let swept = sweep_at(&mut model, 1000 + HOUR);
        assert_eq!(swept.cleared, ["desk:ses_1"]);
        assert_eq!(swept.windows, 1);
        assert_eq!(swept.mode, AutoClear::Seen1h);
        assert!(swept.away, "nobody was looking");
        assert_eq!(model.entry("desk:ses_1").unwrap().cleared, Some(100.0));
        let clear = model.clears.get("desk:ses_1").unwrap();
        assert_eq!(
            (clear.cause, clear.away, clear.seen_at, clear.at),
            (Cause::Auto, true, Some(1000), 1000 + HOUR)
        );
        assert!(told(&mut model).contains(&"cleared desk:ses_1".to_owned()));
        // a cleared thread is not swept again
        assert!(sweep_at(&mut model, 1000 + 2 * HOUR).cleared.is_empty());
    }

    #[test]
    fn seen1h_leaves_a_thread_nobody_saw() {
        let mut model = done_thread();
        assert!(sweep_at(&mut model, 1000 + 11 * HOUR).cleared.is_empty());
    }

    #[test]
    fn any3h_clears_three_hours_after_the_done_seen_or_not_and_serves_it() {
        let mut model = done_thread();
        mode(&mut model, AutoClear::Any3h);
        assert!(sweep_at(&mut model, 1000 + 3 * HOUR - 1).cleared.is_empty());
        assert_eq!(
            sweep_at(&mut model, 1000 + 3 * HOUR).cleared,
            ["desk:ses_1"]
        );
        assert!(model.needs_open().is_empty(), "the badge drops");
        assert!(
            told(&mut model).contains(&"served done:desk:ses_1:msg_a by agent cleared".to_owned())
        );
        assert_eq!(
            model.away(),
            [wire::AwayThread {
                key: "desk:ses_1".into(),
                done_at: 1000,
                seen_at: None,
                cleared_at: 1000 + 3 * HOUR,
            }]
        );
    }

    #[test]
    fn any3h_counts_a_quiet_thread_from_the_first_sweep_that_found_it_idle() {
        let mut model = Model::new();
        model.at(1000);
        event(&mut model, None, &updated("ses_1", 100, None));
        mode(&mut model, AutoClear::Any3h);
        assert!(
            sweep_at(&mut model, 2000).cleared.is_empty(),
            "now it is seen idle"
        );
        assert!(sweep_at(&mut model, 2000 + 3 * HOUR - 1).cleared.is_empty());
        // touched since: its quiet starts again
        event(&mut model, None, &updated("ses_1", 150, None));
        assert!(sweep_at(&mut model, 2000 + 3 * HOUR).cleared.is_empty());
        assert_eq!(
            sweep_at(&mut model, 2000 + 6 * HOUR).cleared,
            ["desk:ses_1"]
        );
    }

    #[test]
    fn never_clears_nothing_however_long() {
        let mut model = seen_thread();
        mode(&mut model, AutoClear::Never);
        let swept = sweep_at(&mut model, 1000 + 10 * HOUR);
        assert!(swept.cleared.is_empty());
        assert_eq!(swept.windows, 0, "it does not even look");
        assert!(model.entry("desk:ses_1").unwrap().cleared.is_none());
    }

    #[test]
    fn the_sweep_clears_a_settled_thread_under_either_rule() {
        let mut model = done_thread();
        assert_eq!(cleared_late(&mut model), ["desk:ses_1"]);
    }

    #[test]
    fn the_sweep_never_clears_a_thread_asking_for_permission() {
        let mut model = done_thread();
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"permission.asked","properties":{"id":"per_1","sessionID":"ses_1","permission":"read","patterns":[],"metadata":{},"always":[]}}"#,
        );
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_asking_a_question() {
        let mut model = done_thread();
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"question.asked","properties":{"id":"que_1","sessionID":"ses_1","questions":[]}}"#,
        );
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_that_failed() {
        let mut model = done_thread();
        event(
            &mut model,
            None,
            r#"{"id":"e","type":"session.error","properties":{"sessionID":"ses_1","error":{"name":"ProviderError","data":{"message":"the provider is down"}}}}"#,
        );
        assert!(model.needs_open().iter().any(|n| n.kind == NeedKind::Fault));
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_that_stopped() {
        let mut model = Model::new();
        model.at(1000);
        event(&mut model, None, &updated("ses_1", 100, None));
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "aborted");
        idle(&mut model, "ses_1");
        assert!(model.needs_open().iter().any(|n| n.kind == NeedKind::Fault));
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_whose_worktree_waits_on_review() {
        let mut model = done_thread();
        event(
            &mut model,
            Some(1),
            r#"{"id":"e","type":"worktree.review.requested","properties":{"name":"fix-auth","branch":"cmx2/fix-auth","sessionID":"ses_1"}}"#,
        );
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_with_prompts_queued() {
        let mut model = done_thread();
        model.sessions.get_mut("desk:ses_1").unwrap().thread.queued = 1;
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_at_work() {
        let mut model = done_thread();
        busy(&mut model, "ses_1");
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_parked_on_its_agents() {
        let mut model = done_thread();
        event(
            &mut model,
            None,
            &status(
                "ses_1",
                r#"{"type":"idle","since":9,"parked":{"agents":1,"jobs":0}}"#,
            ),
        );
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_thread_parked_on_jobs_alone() {
        let mut model = done_thread();
        event(
            &mut model,
            None,
            &status(
                "ses_1",
                r#"{"type":"idle","since":9,"parked":{"agents":0,"jobs":2}}"#,
            ),
        );
        assert!(cleared_late(&mut model).is_empty());
    }

    #[test]
    fn the_sweep_never_clears_a_subagent() {
        let mut model = Model::new();
        model.at(1000);
        event(&mut model, None, &updated("ses_p", 100, None));
        event(&mut model, None, &updated("ses_c", 100, Some("ses_p")));
        let cleared = cleared_late(&mut model);
        assert_eq!(
            cleared,
            ["desk:ses_p"],
            "the parent goes, its subagent has no window"
        );
    }

    #[test]
    fn the_sweep_leaves_a_thread_cleared_by_hand_as_it_was() {
        let mut model = done_thread();
        model.clear(&["desk:ses_1".to_owned()], &phone());
        assert!(cleared_late(&mut model).is_empty());
        assert_eq!(model.clears.get("desk:ses_1").unwrap().cause, Cause::Hand);
        assert!(model.away().is_empty(), "a hand clear is never away");
    }

    #[test]
    fn a_thread_brought_back_is_kept_from_the_sweep_until_it_is_updated() {
        let mut model = seen_thread();
        assert_eq!(sweep_at(&mut model, 1000 + HOUR).cleared, ["desk:ses_1"]);
        model.drain();
        let (changes, answers) = model.unclear(&["desk:ses_1".to_owned()]);
        assert_eq!(
            answers,
            [("desk:ses_1".to_owned(), Ok(Cause::Auto))],
            "it undid the sweep's clear"
        );
        assert!(
            threads_of(&changes)
                .iter()
                .any(|t| t.key == "desk:ses_1" && t.cleared.is_none())
        );
        assert_eq!(
            order(&model),
            ["desk:ses_1"],
            "back where its order puts it"
        );
        assert_eq!(
            told(&mut model),
            ["uncleared desk:ses_1", "kept desk:ses_1"]
        );
        assert!(model.away().is_empty());
        assert!(
            sweep_at(&mut model, 1000 + 5 * HOUR).cleared.is_empty(),
            "kept"
        );
        // updated past the unclear (a rename): the kept mark is spent at the next sweep, and the
        // rule applies again (its finished reply was seen hours ago)
        event(&mut model, None, &updated("ses_1", 200, None));
        assert_eq!(
            sweep_at(&mut model, 1000 + 6 * HOUR).cleared,
            ["desk:ses_1"]
        );
        assert!(told(&mut model).contains(&"unkept desk:ses_1".to_owned()));
    }

    #[test]
    fn an_unclear_refuses_a_thread_that_is_not_cleared_or_not_held() {
        let mut model = done_thread();
        let (changes, answers) =
            model.unclear(&["desk:ses_1".to_owned(), "desk:ses_gone".to_owned()]);
        assert!(changes.is_empty());
        assert_eq!(
            answers,
            [
                ("desk:ses_1".to_owned(), Err(UnclearRefused::NotCleared)),
                (
                    "desk:ses_gone".to_owned(),
                    Err(UnclearRefused::NoSuchSession)
                ),
            ]
        );
        assert!(model.clears.kept("desk:ses_1").is_none());
        // undoing a hand clear brings it back the same way
        model.clear(&["desk:ses_1".to_owned()], &phone());
        let (_, answers) = model.unclear(&["desk:ses_1".to_owned()]);
        assert_eq!(answers[0].1, Ok(Cause::Hand), "it undid a hand clear");
        assert!(model.entry("desk:ses_1").unwrap().cleared.is_none());
    }

    #[test]
    fn a_sweep_while_a_device_looks_is_not_away() {
        let mut model = seen_thread();
        looking_now(&mut model);
        let swept = sweep_at(&mut model, 1000 + HOUR);
        assert_eq!(swept.cleared, ["desk:ses_1"]);
        assert!(!swept.away);
        assert!(!model.clears.get("desk:ses_1").unwrap().away);
        assert!(model.away().is_empty(), "the looking device had the undo");
    }

    #[test]
    fn the_away_summary_empties_when_acknowledged_and_its_threads_stay_cleared() {
        let mut model = seen_thread();
        sweep_at(&mut model, 1000 + HOUR);
        assert_eq!(model.away().len(), 1);
        model.drain();
        assert_eq!(model.away_seen(), 1);
        assert_eq!(told(&mut model), ["away acked"]);
        assert!(model.away().is_empty());
        assert!(model.entry("desk:ses_1").unwrap().cleared.is_some());
        assert_eq!(model.away_seen(), 0);
        assert!(told(&mut model).is_empty(), "nothing left to write");
    }

    #[test]
    fn a_thread_that_comes_back_leaves_the_away_summary() {
        let mut model = seen_thread();
        sweep_at(&mut model, 1000 + HOUR);
        assert_eq!(model.away().len(), 1);
        busy(&mut model, "ses_1");
        assert!(model.away().is_empty());
        assert!(told(&mut model).contains(&"uncleared desk:ses_1".to_owned()));
    }

    #[test]
    fn one_sweep_clears_at_most_a_hundred_and_leaves_the_rest_for_the_next() {
        let mut model = Model::new();
        model.at(1000);
        for n in 0..=MAX_SWEEP_CLEARS {
            event(&mut model, None, &updated(&format!("ses_{n}"), 100, None));
        }
        mode(&mut model, AutoClear::Any3h);
        assert!(sweep_at(&mut model, 2000).cleared.is_empty());
        let first = sweep_at(&mut model, 2000 + 3 * HOUR);
        assert_eq!((first.cleared.len(), first.left), (MAX_SWEEP_CLEARS, 1));
        let second = sweep_at(&mut model, 2000 + 3 * HOUR + 1);
        assert_eq!((second.cleared.len(), second.left), (1, 0));
    }

    /// `ses_job`'s job notice, and a done in `ses_1` whose notice carries the badge.
    fn job_and_done(jobs_as_needs: bool) -> (Model, Option<u32>) {
        let mut model = Model::new();
        model.set_home(HomePrefs {
            jobs_as_needs,
            ..HomePrefs::default()
        });
        model.at(1000);
        event(&mut model, None, &updated("ses_job", 50, None));
        event(&mut model, None, &updated("ses_1", 100, None));
        event(
            &mut model,
            Some(3),
            r#"{"id":"e","type":"process.notify","properties":{"process":{"id":"proc_1","sessionID":"ses_job","pid":1,"command":"bun test","cwd":"/w","title":"bun test","kind":"job","status":"exited","exitCode":0,"ports":[],"origin":"model","startedAt":1},"reason":"exit","detail":"118 passed"}}"#,
        );
        busy(&mut model, "ses_1");
        reply(&mut model, "ses_1", "msg_a", "stop");
        idle(&mut model, "ses_1");
        let badge = model.drain().into_iter().find_map(|e| match e {
            Effect::Notice(n) if n.id.starts_with("done:") => n.badge,
            _ => None,
        });
        (model, badge)
    }

    #[test]
    fn a_job_notice_stays_out_of_the_badge_and_the_lead_unless_it_counts() {
        let (model, badge) = job_and_done(false);
        assert_eq!(badge, Some(1), "the done alone");
        assert_eq!(order(&model), ["desk:ses_1", "desk:ses_job"]);
        assert!(
            model
                .entry("desk:ses_job")
                .unwrap()
                .needs
                .iter()
                .any(|n| n.kind == NeedKind::Job),
            "the wire still lists it"
        );
        let (model, badge) = job_and_done(true);
        assert_eq!(badge, Some(2), "the job counts too");
        assert_eq!(
            order(&model),
            ["desk:ses_1", "desk:ses_job"],
            "both are news, newest first"
        );
        // the job thread leads an idle thread only when it counts
        let (mut off, _) = job_and_done(false);
        let (mut on, _) = job_and_done(true);
        for model in [&mut off, &mut on] {
            model.read("desk:ses_1", &phone(), "msg_a", 100.0).unwrap();
        }
        assert_eq!(order(&off), ["desk:ses_1", "desk:ses_job"]);
        assert_eq!(order(&on), ["desk:ses_job", "desk:ses_1"]);
    }
}
