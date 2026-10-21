//! the fold: one pass over a thread's messages, oldest first, giving the
//! summary's turns, spawns, files and the thread's own child facts, as the
//! app computes them from the whole thread today (`docs/protocol.md`,
//! section 12). each rule names the app's line it reproduces; the goldens
//! under `fold/goldens` are the app's own answer for the thread fixtures
//! (`scripts/summary-reference.ts`), and `fold/tests.rs` holds the fold to
//! them.
//!
//! what it holds while it folds: one entry per turn (its row of the
//! summary and the files it edited, by path), the spawns, and, for a thread
//! whose directory is `/` or unknown, a count per directory of the files its
//! tools named (the app's `projectRoot`). never a message or a part.

// the summary route reads it; until it lands only the tests do

use std::collections::HashMap;

use serde::{Serialize, Serializer};
use serde_json::Value;
use utoipa::ToSchema;

use crate::source::MessageWithParts;
use crate::wire::{Family, Part, Role, ToolPart, ToolStatus};

/// a turn's line: read from this many utf-16 units of its prompt, cut at
/// this many (`stage.tsx`, `firstLineOf`).
const LINE_READ: usize = 20_000;
const LINE_MAX: usize = 300;

/// what one streamed read folds into.
#[derive(Debug, Default)]
pub struct Fold {
    /// the thread's directory: the root paths are shortened against, unless
    /// it is `/` or empty (`model.ts`, `projectRoot`).
    directory: String,
    total: u64,
    turns: Vec<Building>,
    spawns: Vec<Spawn>,
    /// files per directory prefix, while the root is not the directory.
    roots: Option<Roots>,
    first: Option<f64>,
    last_completed: Option<f64>,
    /// the newest message is a user message with no part yet, which the app
    /// does not show (`model.ts`, `shownCount`).
    trailing_empty: bool,
}

#[derive(Debug, Default)]
struct Roots {
    files: u64,
    counts: HashMap<String, u64>,
}

/// a turn while its messages come.
#[derive(Debug)]
struct Building {
    turn: Turn,
    /// its user message carries a compaction.
    compacted: bool,
    /// the newest item is said words: the turn's answer (`model.ts:626-632`).
    answer: bool,
    /// the completed edits, one entry per path as the tool named it, in the
    /// order of their first edit.
    files: Vec<Edit>,
}

#[derive(Debug)]
struct Edit {
    path: String,
    add: f64,
    del: f64,
    at: f64,
}

/// what started a turn (`model.ts`, `Origin`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum By {
    You,
    Queued,
    Brief,
    Mail,
    Notice,
    Compaction,
}

/// how a turn stands (`model.ts`, `TurnStatus`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Done,
    Working,
    Aborted,
    Failed,
}

/// one turn of the summary.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// its user message's id.
    pub id: String,
    pub by: By,
    /// a report's or a brief's sender, by name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// the sender's session, when the daemon said.
    #[serde(rename = "fromID", skip_serializing_if = "Option::is_none")]
    pub from_id: Option<String>,
    /// the mail was a note, not a report.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub note: bool,
    #[serde(serialize_with = "whole")]
    pub at: f64,
    #[serde(serialize_with = "whole")]
    pub end: f64,
    /// the prompt's first line with words, at most 300 characters; empty
    /// for a mail or compaction turn, whose label the client builds.
    pub line: String,
    pub steps: u32,
    /// one of its steps asks (family `ask`); absent with no steps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<bool>,
    /// one of its steps failed and was not interrupted; absent with no steps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// its assistant messages' costs summed, a compaction's summary left
    /// out; absent at zero.
    #[serde(serialize_with = "whole", skip_serializing_if = "is_zero")]
    pub cost: f64,
    /// it ended in said words after its last step.
    pub answered: bool,
    /// the messages it holds, its user message among them.
    pub messages: u32,
}

/// a spawn step.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Spawn {
    /// the turn it is in.
    pub turn: String,
    /// its tool part's id.
    pub part: String,
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// the session it started, when the daemon said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child: Option<String>,
    #[serde(serialize_with = "whole")]
    pub at: f64,
}

/// a file the thread edited, its counts summed over its completed edits.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    /// short against the project root, `~` for a home outside it.
    pub path: String,
    #[serde(serialize_with = "whole")]
    pub add: f64,
    #[serde(serialize_with = "whole")]
    pub del: f64,
    /// when its newest completed edit started.
    #[serde(serialize_with = "whole")]
    pub at: f64,
}

/// a held child thread's facts, for its parent's agent rows and lanes
/// (`live.ts:155-185`).
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Child {
    pub key: String,
    pub steps: u64,
    /// its first message's creation.
    #[serde(serialize_with = "whole")]
    pub first: f64,
    /// its last message's completion, else `first`.
    #[serde(serialize_with = "whole")]
    pub end: f64,
}

/// the fold's answer, before the route adds `key`, `v`, `rv` and `children`.
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    /// the messages read, every one.
    pub total: u64,
    pub turns: Vec<Turn>,
    pub spawns: Vec<Spawn>,
    /// in the order the details panel lists them (`details-model.ts`,
    /// `filesChanged`): the newest turn's first, and inside a turn the path
    /// it first edited last.
    pub files: Vec<Touched>,
    /// the first message's creation, zero with none.
    pub first: f64,
    /// the last message's completion, else `first`.
    pub end: f64,
}

impl Summary {
    /// the thread's own facts as its parent shows them for a held child
    /// (`live.ts:155-185`).
    #[must_use]
    pub fn as_child(&self, key: &str) -> Child {
        Child {
            key: key.to_owned(),
            steps: self.turns.iter().map(|t| u64::from(t.steps)).sum(),
            first: self.first,
            end: self.end,
        }
    }
}

impl Fold {
    /// a fold for a thread in `directory`, the one its file paths are
    /// shortened against.
    #[must_use]
    pub fn new(directory: &str) -> Self {
        let rootless = directory.is_empty() || directory == "/";
        Self {
            directory: directory.to_owned(),
            roots: rootless.then(Roots::default),
            ..Self::default()
        }
    }

    /// takes the next message, oldest first.
    pub fn push(&mut self, message: &MessageWithParts) {
        let info = &message.info;
        self.total += 1;
        self.first.get_or_insert(info.created);
        self.last_completed = info.completed;
        self.trailing_empty = info.role == Role::User && message.parts.is_empty();
        if let Some(roots) = &mut self.roots {
            roots.count(&message.parts);
        }
        match info.role {
            Role::User => self.turns.push(begin(message)),
            Role::Assistant => {
                let Some(cur) = self.turns.last_mut() else {
                    return;
                };
                cur.turn.messages += 1;
                cur.reply(message, &mut self.spawns);
            }
        }
    }

    #[must_use]
    pub fn finish(mut self) -> Summary {
        if self.trailing_empty {
            self.turns.pop();
        }
        let root = match &self.roots {
            Some(roots) => roots.root().unwrap_or(&self.directory).to_owned(),
            None => self.directory.clone(),
        };
        let files = files(&self.turns, &root);
        let first = self.first.unwrap_or(0.0);
        Summary {
            total: self.total,
            turns: self
                .turns
                .into_iter()
                .map(|b| {
                    let mut turn = b.turn;
                    turn.answered = b.answer;
                    if turn.steps == 0 {
                        turn.ask = None;
                        turn.error = None;
                    }
                    turn
                })
                .collect(),
            spawns: self.spawns,
            files,
            first,
            end: self.last_completed.unwrap_or(first),
        }
    }
}

impl Roots {
    /// `projectRoot`'s count: each tool's `filePath` adds one to every
    /// directory above it, from the third piece of its path down.
    fn count(&mut self, parts: &[Part]) {
        for part in parts {
            let Part::Tool(tool) = part else { continue };
            let Some(path) = json(tool.state.input.get())
                .get("filePath")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            self.files += 1;
            let pieces: Vec<&str> = path.split('/').collect();
            for i in 3..pieces.len() {
                *self.counts.entry(pieces[..i].join("/")).or_default() += 1;
            }
        }
    }

    /// the deepest directory holding 85% of the files, if one does.
    fn root(&self) -> Option<&str> {
        #[allow(clippy::cast_precision_loss, reason = "counts stay far below 2^52")]
        let floor = self.files as f64 * 0.85;
        #[allow(clippy::cast_precision_loss, reason = "counts stay far below 2^52")]
        self.counts
            .iter()
            .filter(|(_, n)| **n as f64 >= floor)
            .max_by_key(|(dir, _)| dir.len())
            .map(|(dir, _)| dir.as_str())
    }
}

/// a turn from its user message (`model.ts:567-574`).
fn begin(message: &MessageWithParts) -> Building {
    let info = &message.info;
    let origin = origin(&message.parts, info.queued, info.notice);
    let compacted = message
        .parts
        .iter()
        .any(|p| matches!(p, Part::Compaction(_)));
    let by = if compacted { By::Compaction } else { origin.by };
    let line = if matches!(by, By::Mail | By::Compaction) {
        String::new()
    } else {
        first_line(&origin.text)
    };
    Building {
        turn: Turn {
            id: info.id.clone(),
            by,
            from: origin.from,
            from_id: origin.from_id.filter(|id| !id.is_empty()),
            note: origin.note,
            at: info.created,
            end: info.created,
            line,
            steps: 0,
            ask: Some(false),
            error: Some(false),
            status: Status::Done,
            model: None,
            effort: None,
            cost: 0.0,
            answered: false,
            messages: 1,
        },
        compacted,
        answer: false,
        files: Vec::new(),
    }
}

struct Origin {
    by: By,
    text: String,
    from: Option<String>,
    from_id: Option<String>,
    note: bool,
}

/// a user message's origin (`model.ts:433-455`). the message's own `mail`
/// is not on the neutral message; its text parts' is.
fn origin(parts: &[Part], queued: bool, notice: bool) -> Origin {
    let texts: Vec<&crate::wire::TextPart> = parts
        .iter()
        .filter_map(|p| match p {
            Part::Text(t) => Some(t),
            _ => None,
        })
        .collect();
    let join = |pick: &dyn Fn(&crate::wire::TextPart) -> bool, sep: &str| {
        texts
            .iter()
            .filter(|t| pick(t))
            .map(|t| t.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(sep)
    };
    let plain = |by| Origin {
        by,
        text: String::new(),
        from: None,
        from_id: None,
        note: false,
    };
    if notice || texts.iter().any(|t| t.notice) {
        return Origin {
            text: join(&|_| true, "\n"),
            ..plain(By::Notice)
        };
    }
    if let Some(mail) = texts.iter().find_map(|t| t.mail.as_ref()) {
        let from = Some(
            mail.from
                .as_deref()
                .map(|f| {
                    f.strip_prefix("/root/")
                        .or_else(|| (f == "/root").then_some(""))
                        .unwrap_or(f)
                })
                .filter(|f| !f.is_empty())
                .unwrap_or("root")
                .to_owned(),
        );
        let from_id = mail.from_id.clone();
        return match mail.kind.as_str() {
            "task" => Origin {
                text: join(&|t| !t.synthetic, "\n"),
                from,
                from_id,
                ..plain(By::Brief)
            },
            "job" | "system" => Origin {
                text: join(&|_| true, "\n"),
                ..plain(By::Notice)
            },
            kind => Origin {
                text: join(&|_| true, "\n"),
                from,
                from_id,
                note: kind == "message",
                ..plain(By::Mail)
            },
        };
    }
    let typed = |t: &crate::wire::TextPart| !t.synthetic && !t.notice;
    if !texts.iter().any(|t| typed(t)) {
        let imported = texts
            .iter()
            .filter(|t| t.synthetic)
            .find_map(|t| imported_from(t.text.as_deref().unwrap_or("")));
        if let Some(sender) = imported {
            let from = sender.strip_prefix("/root/").unwrap_or(sender);
            return Origin {
                from: (!from.is_empty()).then(|| from.to_owned()),
                ..plain(By::Mail)
            };
        }
    }
    Origin {
        text: join(&typed, "\n"),
        ..plain(if queued { By::Queued } else { By::You })
    }
}

/// the sender of imported history's report, `[from /root/name]: ...`.
fn imported_from(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("[from ")?;
    if !rest.starts_with("/root") {
        return None;
    }
    let close = rest.find(']')?;
    rest[close + 1..].starts_with(':').then(|| &rest[..close])
}

impl Building {
    /// an assistant message of this turn (`model.ts:576-624`).
    fn reply(&mut self, message: &MessageWithParts, spawns: &mut Vec<Spawn>) {
        let info = &message.info;
        // a compaction's summary is its card, not the turn's work
        // (`model.ts:577-581`)
        if self.compacted && info.summary {
            return;
        }
        let turn = &mut self.turn;
        turn.cost += info.cost.unwrap_or(0.0);
        turn.end = info.completed.unwrap_or(turn.end);
        if let Some(model) = info.model.as_ref().filter(|m| !m.is_empty()) {
            turn.model = Some(model.clone());
        }
        if let Some(effort) = info.effort.as_ref().filter(|e| !e.is_empty()) {
            turn.effort = Some(effort.clone());
        }
        if info.completed.is_none() {
            turn.status = Status::Working;
        }
        let aborted = info.finish.as_deref() == Some("aborted");
        if let Some(error) = &info.error {
            turn.status = if aborted || error.name.as_deref() == Some("MessageAbortedError") {
                Status::Aborted
            } else {
                Status::Failed
            };
        } else if aborted {
            turn.status = Status::Aborted;
        }
        let mut floor = info.created;
        for part in &message.parts {
            let time = match part {
                Part::Text(p) => p.time.as_ref(),
                Part::Reasoning(p) => p.time.as_ref(),
                _ => None,
            }
            .filter(|t| t.start.is_some() || t.end.is_some());
            let at = time.and_then(|t| t.start).unwrap_or(floor);
            floor = floor
                .max(time.and_then(|t| t.start).unwrap_or(0.0))
                .max(time.and_then(|t| t.end).unwrap_or(0.0));
            match part {
                Part::Text(p) => {
                    if p.synthetic || (js_blank(p.text.as_deref().unwrap_or("")) && !p.streaming) {
                        continue;
                    }
                    self.answer = true;
                }
                Part::Reasoning(p) => {
                    if js_blank(p.text.as_deref().unwrap_or("")) && !p.streaming {
                        continue;
                    }
                    self.answer = false;
                }
                Part::Tool(p) => {
                    let step_at = self.step(p, at, spawns);
                    floor = floor.max(step_at);
                    self.answer = false;
                }
                _ => {}
            }
        }
    }

    /// a tool step (`model.ts:247-425`, the parts the summary reads):
    /// counted, its ask and fault, its edit's counts, its spawn. gives when
    /// it started.
    fn step(&mut self, part: &ToolPart, message_at: f64, spawns: &mut Vec<Spawn>) -> f64 {
        let state = &part.state;
        let at = state
            .time
            .as_ref()
            .and_then(|t| t.start.or(t.end))
            .unwrap_or(message_at);
        let turn = &mut self.turn;
        turn.steps += 1;
        if part.family == Family::Ask {
            turn.ask = Some(true);
        }
        let reads_meta = state.status == ToolStatus::Error
            || matches!(part.family, Family::Edit | Family::Spawn);
        if !reads_meta {
            return at;
        }
        let input = json(state.input.get());
        let meta = state
            .metadata
            .as_ref()
            .map_or(Value::Null, |m| json(m.get()));
        if state.status == ToolStatus::Error {
            let words = state.error.as_deref().unwrap_or("undefined").to_lowercase();
            let interrupted = meta.get("interrupted") == Some(&Value::Bool(true))
                || ["aborted", "interrupt", "denied"]
                    .iter()
                    .any(|w| words.contains(w));
            if !interrupted {
                turn.error = Some(true);
            }
        }
        match part.family {
            Family::Edit if state.status == ToolStatus::Completed => {
                let path = [
                    input.get("filePath"),
                    input.get("path"),
                    meta.get("path"),
                    meta.get("filepath"),
                ]
                .into_iter()
                .find_map(|v| v.and_then(Value::as_str))
                .unwrap_or("");
                if path.is_empty() {
                    return at;
                }
                let (add, del) = counts(&part.tool, &input, &meta);
                match self.files.iter_mut().find(|e| e.path == path) {
                    Some(e) => {
                        e.add += add;
                        e.del += del;
                        e.at = e.at.max(at);
                    }
                    None => self.files.push(Edit {
                        path: path.to_owned(),
                        add,
                        del,
                        at,
                    }),
                }
            }
            Family::Spawn => spawns.push(spawn(&self.turn.id, part, &input, &meta, at)),
            _ => {}
        }
        at
    }
}

/// an edit's added and deleted lines (`model.ts:294-323`).
fn counts(tool: &str, input: &Value, meta: &Value) -> (f64, f64) {
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let number = |v: Option<&Value>, k: &str| v.and_then(|v| v.get(k)).and_then(Value::as_f64);
    if tool == "write" {
        return (
            line_count(text(input, "content").as_deref().unwrap_or("")),
            0.0,
        );
    }
    let fd = meta.get("filediff").filter(|v| v.is_object());
    let patch = fd
        .and_then(|fd| text(fd, "patch"))
        .or_else(|| text(meta, "diff"));
    if fd.is_some()
        && (number(fd, "additions").is_some() || patch.as_deref().is_some_and(|p| !p.is_empty()))
    {
        let lines: Vec<&str> = patch.as_deref().unwrap_or("").split('\n').collect();
        #[allow(
            clippy::cast_precision_loss,
            reason = "line counts stay far below 2^52"
        )]
        let marked = |sign: &str, three: &str| {
            lines
                .iter()
                .filter(|l| l.starts_with(sign) && !l.starts_with(three))
                .count() as f64
        };
        let add = number(fd, "additions").unwrap_or_else(|| marked("+", "+++"));
        let del = number(fd, "deletions").unwrap_or_else(|| marked("-", "---"));
        return (add, del);
    }
    let old = text(input, "oldString").or_else(|| text(input, "old_text"));
    let new = text(input, "newString").or_else(|| text(input, "new_text"));
    match (old, new) {
        (Some(old), Some(new)) => (line_count(&new), line_count(&old)),
        _ => (0.0, 0.0),
    }
}

/// a spawn step's agent (`model.ts:364-371`).
fn spawn(turn: &str, part: &ToolPart, input: &Value, meta: &Value, at: f64) -> Spawn {
    fn text<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a str> {
        v.and_then(|v| v.get(k)).and_then(Value::as_str)
    }
    let first = meta
        .get("agents")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .filter(|v| v.is_object());
    let name = text(first, "name")
        .or_else(|| text(Some(meta), "path"))
        .or_else(|| text(Some(meta), "task_name"))
        .or_else(|| text(Some(input), "task_name"))
        .or_else(|| text(Some(input), "name"))
        .unwrap_or("agent");
    let name = name.strip_prefix("/root/").unwrap_or(name).to_owned();
    let kind = text(first, "seat")
        .or_else(|| text(Some(input), "agent_type"))
        .or_else(|| text(Some(input), "seat"))
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let child = text(Some(meta), "child_session_id")
        .or_else(|| text(first, "id"))
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    Spawn {
        turn: turn.to_owned(),
        part: part.id.clone(),
        name,
        kind,
        child,
        at,
    }
}

/// every file the turns edited, as `filesChanged` lists them
/// (`details-model.ts:86-103`), paths short against `root`.
fn files(turns: &[Building], root: &str) -> Vec<Touched> {
    let mut out: Vec<Touched> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for building in turns.iter().rev() {
        // the turn's own map, keyed by the short path in the order of its
        // first edit (`model.ts:612-616`)
        let mut own: Vec<Touched> = Vec::new();
        for edit in &building.files {
            let path = short_path(&edit.path, root);
            if path.is_empty() {
                continue;
            }
            match own.iter_mut().find(|t| t.path == path) {
                Some(t) => {
                    t.add += edit.add;
                    t.del += edit.del;
                    t.at = t.at.max(edit.at);
                }
                None => own.push(Touched {
                    path,
                    add: edit.add,
                    del: edit.del,
                    at: edit.at,
                }),
            }
        }
        for t in own.into_iter().rev() {
            if let Some(&i) = at.get(&t.path) {
                let sum = &mut out[i];
                sum.add += t.add;
                sum.del += t.del;
                sum.at = sum.at.max(t.at);
            } else {
                at.insert(t.path.clone(), out.len());
                out.push(t);
            }
        }
    }
    out
}

/// a path relative to the project root; outside it, with `~` for a home
/// (`model.ts`, `shortPath`).
fn short_path(path: &str, root: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    if !root.is_empty()
        && let Some(rest) = path.strip_prefix(root).and_then(|r| r.strip_prefix('/'))
    {
        return rest.to_owned();
    }
    for home in ["/Users/", "/home/"] {
        if let Some(rest) = path.strip_prefix(home) {
            let name = rest.find('/').unwrap_or(rest.len());
            if name > 0 {
                return format!("~{}", &rest[name..]);
            }
        }
    }
    path.to_owned()
}

/// the first line with words in it, to 300 characters, from the first
/// 20,000 (`stage.tsx`, `firstLineOf`): counted in utf-16 units, as the
/// app counts.
fn first_line(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().take(LINE_READ).collect();
    for line in units.split(|u| *u == u16::from(b'\n')) {
        let words = String::from_utf16_lossy(line);
        if !js_blank(&words) {
            return String::from_utf16_lossy(&line[..line.len().min(LINE_MAX)]);
        }
    }
    String::new()
}

/// nothing but what javascript's `trim` removes.
fn js_blank(text: &str) -> bool {
    text.chars()
        .all(|c| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// `lineCount`: the lines of a string, none for an empty one.
fn line_count(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    #[allow(
        clippy::cast_precision_loss,
        reason = "line counts stay far below 2^52"
    )]
    let lines = (text.matches('\n').count() + 1) as f64;
    lines
}

/// a tool's json as the source sent it, `null` when it is not json.
fn json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if passes a reference"
)]
fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

/// a number as javascript writes it: a whole one without a fraction.
#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's serialize_with passes a reference"
)]
fn whole<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    #[allow(clippy::float_cmp, reason = "an exact test for a whole number")]
    let integral = value.fract() == 0.0 && value.abs() < 9e15;
    if integral {
        #[allow(clippy::cast_possible_truncation, reason = "whole and below 2^53")]
        return serializer.serialize_i64(*value as i64);
    }
    serializer.serialize_f64(*value)
}

#[cfg(test)]
mod tests;
