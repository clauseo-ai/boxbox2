//! the cmx2 translation table: one row per domain event boxbox consumes
//! (19: the session, status, transcript, ask and need events), each
//! turning a decoded cmx2 event into exactly one `SourceEvent`
//! (`docs/agents.md`, section 4). every other type the contract declares
//! stays decoded and ignored, as it always was. the whole payload rides
//! beside the event for contract 1, which journals cmx2's objects byte for
//! byte.
//!
//! the facts the reducer decides with are read here with today's
//! leniency: what the model read loosely from the daemon's json, this
//! reads the same way, so a cmx2 thread moves exactly as it did before the
//! seam. a part whose neutral form would tell the reducer something other
//! than the daemon's json does is kept as an `unknown` part carrying that
//! json, which the reducer reads as it always did.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::cmx2::{self, Event};
use crate::fleet::model::{PartFacts, part_facts};
use crate::source::{
    AgentFacts, ConnectionStatus, Floors, MessageWithParts, Notice, RaisedAsk, Snapshot,
    SourceEvent, Stamp, TailRead, ThreadActivity, ThreadFacts,
};
use crate::upstream::{Connection, HostStatus};
use crate::wire::{
    Activity, AgentConnection, AgentStatus, Ask, AskKind, AskSettled, Capabilities, Changes,
    CompactionPart, Context, Family, FilePart, Flavour, ImagePart, Kind, Label, LabelSource, Mail,
    Mark, MarkerKind, MarkerPart, Message, MessageError, Outcome, Part, PartAt, PartTime,
    Permission, PermissionOption, PermissionReply, Place, Question, QuestionOption, ReasoningPart,
    Role, SettledBy, SettlerKind, Source, TextPart, ToolPart, ToolRef, ToolState, ToolStatus,
    ToolTime, Vcs,
};

/// the daemon's own settlers of an ask (cmx2 a6); anything else is a person.
/// `always rule` is the daemon's policy, the rest the system's.
const RUNTIME_SETTLERS: [&str; 1] = ["always rule"];
const SYSTEM_SETTLERS: [&str; 4] = ["abort", "cascade", "session_ended", "daemon_restart"];
/// the file parts a client draws as a picture.
const IMAGE_KINDS: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    properties: &'a RawValue,
}

#[derive(Deserialize)]
struct InfoField<'a> {
    #[serde(borrow)]
    info: &'a RawValue,
}

#[derive(Deserialize)]
struct PartField<'a> {
    #[serde(borrow)]
    part: &'a RawValue,
}

#[derive(Deserialize)]
struct StatusField<'a> {
    #[serde(borrow)]
    status: &'a RawValue,
}

/// who settled an ask, as the daemon's reply events say (cmx2 a4, a6).
#[derive(Deserialize)]
struct SettledByField {
    by: Option<String>,
}

fn properties_of(payload: &RawValue) -> Result<&RawValue, serde_json::Error> {
    serde_json::from_str::<Envelope<'_>>(payload.get()).map(|e| e.properties)
}

/// one decoded daemon event as the source event the reducer takes; none
/// for a type nothing consumes.
///
/// # Errors
/// the payload does not hold a field the decoded event had, which only a
/// decoder bug could cause.
pub fn event(
    host: &str,
    directory: Option<&str>,
    event: &Event,
    payload: &RawValue,
) -> Result<Option<SourceEvent>, serde_json::Error> {
    let properties = || properties_of(payload);
    Ok(Some(match event {
        Event::MessageUpdated(e) => {
            let info = serde_json::from_str::<InfoField<'_>>(properties()?.get())?.info;
            SourceEvent::Message {
                thread: e.properties.session_id.clone(),
                message: Box::new(message(info)?),
            }
        }
        Event::MessagePartUpdated(e) => {
            let part = serde_json::from_str::<PartField<'_>>(properties()?.get())?.part;
            SourceEvent::Part {
                thread: e.properties.session_id.clone(),
                part: Box::new(self::part(part)),
            }
        }
        Event::MessagePartDelta(e) => {
            let p = &e.properties;
            SourceEvent::Delta {
                thread: p.session_id.clone(),
                message: p.message_id.clone(),
                part: p.part_id.clone(),
                field: p.field.clone(),
                delta: p.delta.clone(),
                offset: u64::try_from(p.offset).unwrap_or(0),
            }
        }
        Event::MessageRemoved(e) => SourceEvent::MessageRemoved {
            thread: e.properties.session_id.clone(),
            message: e.properties.message_id.clone(),
        },
        Event::SessionCreated(_)
        | Event::SessionUpdated(_)
        | Event::SessionDeleted(_)
        | Event::SessionStatus(_)
        | Event::SessionIdle(_) => return session(event, payload),
        Event::PermissionAsked(_)
        | Event::QuestionAsked(_)
        | Event::PermissionReplied(_)
        | Event::QuestionReplied(_)
        | Event::QuestionRejected(_) => return asked(host, event, payload),
        Event::SessionError(_)
        | Event::WorktreeReviewRequested(_)
        | Event::WorktreeMerged(_)
        | Event::WorktreeDiscarded(_)
        | Event::ProcessNotify(_) => return Ok(notable(directory, event)),
        _ => return Ok(None),
    }))
}

/// the session rows: a thread born, changed or gone, its activity, its turn's end.
fn session(event: &Event, payload: &RawValue) -> Result<Option<SourceEvent>, serde_json::Error> {
    let properties = || properties_of(payload);
    Ok(Some(match event {
        Event::SessionCreated(e) => {
            let info = serde_json::from_str::<InfoField<'_>>(properties()?.get())?.info;
            SourceEvent::Thread {
                thread: Box::new(thread(&e.properties.info, info.to_owned())),
                born: true,
            }
        }
        Event::SessionUpdated(e) => {
            let info = serde_json::from_str::<InfoField<'_>>(properties()?.get())?.info;
            SourceEvent::Thread {
                thread: Box::new(thread(&e.properties.info, info.to_owned())),
                born: false,
            }
        }
        Event::SessionDeleted(e) => SourceEvent::ThreadRemoved {
            thread: e.properties.session_id.clone(),
        },
        Event::SessionStatus(e) => {
            // the raw status rides in the payload; read it here so a payload without one is skipped as before
            serde_json::from_str::<StatusField<'_>>(properties()?.get())?;
            SourceEvent::Activity {
                thread: e.properties.session_id.clone(),
                activity: activity(&e.properties.status),
            }
        }
        Event::SessionIdle(e) => SourceEvent::TurnEnded {
            thread: e.properties.session_id.clone(),
        },
        _ => return Ok(None),
    }))
}

/// the ask rows: raised, and settled by a reply or a rejection.
fn asked(
    host: &str,
    event: &Event,
    payload: &RawValue,
) -> Result<Option<SourceEvent>, serde_json::Error> {
    let properties = || properties_of(payload);
    Ok(Some(match event {
        Event::PermissionAsked(_) => SourceEvent::AskRaised {
            ask: Box::new(ask(host, AskKind::Permission, properties()?)?),
        },
        Event::QuestionAsked(_) => SourceEvent::AskRaised {
            ask: Box::new(ask(host, AskKind::Question, properties()?)?),
        },
        Event::PermissionReplied(e) => settled(
            host,
            &e.properties.request_id,
            AskKind::Permission,
            Some(e.properties.reply.to_string()),
            properties()?,
        )?,
        Event::QuestionReplied(e) => settled(
            host,
            &e.properties.request_id,
            AskKind::Question,
            None,
            properties()?,
        )?,
        Event::QuestionRejected(e) => settled(
            host,
            &e.properties.request_id,
            AskKind::Question,
            Some("reject".to_owned()),
            properties()?,
        )?,
        _ => return Ok(None),
    }))
}

/// the need rows: a turn's error, a review asked for, a checkout merged or
/// discarded, a job's notice. one with no session raises nothing.
fn notable(directory: Option<&str>, event: &Event) -> Option<SourceEvent> {
    Some(match event {
        Event::SessionError(e) => {
            let Some(id) = &e.properties.session_id else {
                return None;
            };
            SourceEvent::Fault {
                thread: id.clone(),
                words: e.properties.error.data.message.clone(),
            }
        }
        Event::WorktreeReviewRequested(e) => {
            let p = &e.properties;
            let Some(id) = &p.session_id else {
                return None;
            };
            let words = p.note.as_deref().or(p.branch.as_deref()).unwrap_or(&p.name);
            SourceEvent::Notice {
                thread: id.clone(),
                notice: Notice::Review {
                    checkout: p.name.clone(),
                    words: words.to_owned(),
                },
            }
        }
        Event::WorktreeMerged(e) => SourceEvent::ReviewSettled {
            worktree: e.properties.name.clone(),
            directory: directory.map(str::to_owned),
        },
        Event::WorktreeDiscarded(e) => SourceEvent::ReviewSettled {
            worktree: e.properties.name.clone(),
            directory: directory.map(str::to_owned),
        },
        Event::ProcessNotify(e) => {
            let p = &e.properties;
            let Some(id) = &p.process.session_id else {
                return None;
            };
            SourceEvent::Notice {
                thread: id.clone(),
                notice: Notice::Job {
                    process: p.process.id.clone(),
                    reason: p.reason.to_string(),
                    title: p.process.title.clone(),
                    detail: p.detail.clone(),
                },
            }
        }
        _ => return None,
    })
}

fn settled(
    host: &str,
    id: &str,
    kind: AskKind,
    option: Option<String>,
    properties: &RawValue,
) -> Result<SourceEvent, serde_json::Error> {
    let by = serde_json::from_str::<SettledByField>(properties.get())?.by;
    let by = by.map(|name| {
        let kind = if RUNTIME_SETTLERS.contains(&name.as_str()) {
            SettlerKind::Runtime
        } else if SYSTEM_SETTLERS.contains(&name.as_str()) {
            SettlerKind::System
        } else {
            SettlerKind::Device
        };
        SettledBy {
            kind,
            name: Some(name),
            device: None,
        }
    });
    Ok(SourceEvent::AskSettled {
        ask: id.to_owned(),
        kind,
        settled: Box::new(AskSettled {
            agent: host.to_owned(),
            id: id.to_owned(),
            outcome: Outcome::Answered,
            option,
            reason: None,
            by,
            #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
            at: crate::now_ms() as f64,
        }),
    })
}

/// the cmx2 agent of a connection: it is the connection, keyed by its name.
#[must_use]
pub fn agent(host: &str) -> AgentFacts {
    AgentFacts {
        key: host.to_owned(),
        foreign_id: None,
        label: Label {
            name: None,
            source: LabelSource::Cmx,
            machine: host.to_owned(),
        },
        kind: Kind::Coding,
        source: Source::Cmx2,
        mark: Mark::Square,
        palette: None,
        capabilities: Capabilities::cmx2(),
    }
}

/// the host's status as a connection's, carrying the host for contract 1.
#[must_use]
pub fn connection(status: HostStatus) -> ConnectionStatus {
    let agent_status = match status.connection {
        Connection::Connecting => AgentStatus::Connecting,
        Connection::Connected => AgentStatus::Ready,
        Connection::Down => AgentStatus::Down,
    };
    let connection = AgentConnection {
        name: status.name.clone(),
        url: status.url.clone(),
        origin: status.origin,
        since: status.since,
        last_error: status.last_error.clone(),
        connects: status.connects,
        version: status.health.as_ref().map(|h| h.version.clone()),
        pinned: None,
        untested: false,
        protocol: None,
        refused: None,
        contract: status.health.as_ref().map(|h| h.contract),
        contract_matches: status.health.as_ref().map(|h| h.contract_matches),
        frames: status.frames,
        memory: status.memory,
        cursor: status.cursor.clone(),
    };
    ConnectionStatus {
        status: agent_status,
        connection,
        host: Some(Box::new(status)),
    }
}

/// a session as a thread. `raw` is its info as the daemon wrote it.
#[must_use]
pub fn thread(info: &cmx2::SessionInfo, raw: Box<RawValue>) -> ThreadFacts {
    let repo = info
        .project_id
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(&info.title)
        .to_owned();
    let root = if info.project_id.starts_with('/') {
        info.project_id.clone()
    } else {
        info.directory.clone()
    };
    ThreadFacts {
        id: info.id.clone(),
        title: info.title.clone(),
        created: info.time.created,
        updated: info.time.updated,
        said: None,
        generation: None,
        parent: info.parent_id.clone(),
        place: Some(Place {
            root,
            directory: info.directory.clone(),
            name: repo,
        }),
        origin: None,
        queued: 0,
        model: info
            .model
            .as_ref()
            .map(|m| format!("{}/{}", m.provider_id, m.id)),
        effort: info.effort.clone(),
        context: info.context.as_ref().map(|c| Context {
            used: whole(c.used),
            limit: whole(c.limit),
            compact_at: c.compact_at.map(whole),
        }),
        cost: Some(info.cost),
        vcs: info.vcs.as_ref().map(|v| Vcs {
            branch: v.branch.clone(),
            dirty: v.dirty,
        }),
        changes: info.summary.as_ref().map(|s| Changes {
            additions: whole(s.additions),
            deletions: whole(s.deletions),
            files: whole(s.files),
        }),
        browse_only: matches!(info.source, cmx2::SessionInfoSource::Cmx),
        archived: info.time.archived.is_some(),
        raw: Some(raw),
    }
}

/// a session read as json, as a thread.
///
/// # Errors
/// the json is not a session.
pub fn thread_from_json(raw: Box<RawValue>) -> Result<ThreadFacts, serde_json::Error> {
    let info = cmx2::SessionInfo::deserialize(&*raw)?;
    Ok(thread(&info, raw))
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "counts and token figures cmx2 sends as json numbers; negative or fractional ones are nonsense and floor at 0"
)]
fn whole(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value as u64
    } else {
        0
    }
}

/// what a status means: busy and retry as they are, idle with a park as
/// parked, idle as idle.
#[must_use]
pub fn activity(status: &cmx2::SessionStatus) -> Activity {
    match status {
        cmx2::SessionStatus::Busy(b) => Activity::Busy {
            since: b.since.unwrap_or(0.0),
        },
        cmx2::SessionStatus::Retry(r) => Activity::Retry {
            attempt: u32::try_from(r.attempt).unwrap_or(0),
            message: r.message.clone(),
            next: r.next,
            since: r.since,
        },
        cmx2::SessionStatus::Idle(i) => match &i.parked {
            Some(p) => Activity::Parked {
                agents: u32::try_from(p.agents).unwrap_or(0),
                jobs: u32::try_from(p.jobs).unwrap_or(0),
                since: i.since,
            },
            None => Activity::Idle,
        },
    }
}

/// the facts of a message, read as loosely as the reducer always read them.
#[derive(Deserialize)]
struct MessageJson {
    id: String,
    role: String,
    time: MessageTime,
    #[serde(rename = "clientID")]
    client_id: Option<String>,
    #[serde(default)]
    queued: bool,
    finish: Option<String>,
    /// the rest is for contract 2 and never decides anything here, so it
    /// is read without the power to refuse the message.
    #[serde(default)]
    steer: serde_json::Value,
    #[serde(default)]
    error: serde_json::Value,
    #[serde(default)]
    model: serde_json::Value,
    #[serde(default, rename = "modelID")]
    model_id: serde_json::Value,
    #[serde(default, rename = "providerID")]
    provider_id: serde_json::Value,
    #[serde(default)]
    variant: serde_json::Value,
    #[serde(default)]
    cost: serde_json::Value,
}

#[derive(Deserialize)]
struct MessageTime {
    created: f64,
    completed: Option<f64>,
}

/// a message's info as a message.
///
/// # Errors
/// it lacks an id, a role or a creation time.
pub fn message(info: &RawValue) -> Result<Message, serde_json::Error> {
    let m: MessageJson = serde_json::from_str(info.get())?;
    let text = |v: &serde_json::Value| v.as_str().map(str::to_owned);
    let model = match (&m.model, text(&m.provider_id), text(&m.model_id)) {
        (serde_json::Value::Object(o), _, _) => match (
            o.get("providerID").and_then(serde_json::Value::as_str),
            o.get("modelID").and_then(serde_json::Value::as_str),
        ) {
            (Some(provider), Some(id)) => Some(format!("{provider}/{id}")),
            _ => None,
        },
        (_, Some(provider), Some(id)) => Some(format!("{provider}/{id}")),
        _ => None,
    };
    Ok(Message {
        id: m.id,
        role: if m.role == "user" {
            Role::User
        } else {
            Role::Assistant
        },
        created: m.time.created,
        completed: m.time.completed,
        position: None,
        client_id: m.client_id,
        queued: m.queued,
        steer: m.steer.as_bool().unwrap_or(false),
        finish: m.finish,
        error: m
            .error
            .pointer("/data/message")
            .and_then(serde_json::Value::as_str)
            .map(|message| MessageError {
                message: message.to_owned(),
            }),
        model,
        effort: text(&m.variant),
        cost: m.cost.as_f64(),
        sender: None,
        origin: None,
        quote: None,
        reactions: None,
    })
}

/// a part, as loosely as the reducer read one: everything beyond its
/// facts is read without the power to refuse it.
#[derive(Deserialize)]
struct PartJson {
    id: String,
    #[serde(rename = "messageID")]
    message_id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    synthetic: bool,
    #[serde(default)]
    time: serde_json::Value,
    #[serde(default)]
    mail: serde_json::Value,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default, rename = "callID")]
    call_id: Option<String>,
    #[serde(default)]
    state: Option<Box<RawValue>>,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    auto: Option<bool>,
    #[serde(default)]
    overflow: Option<bool>,
    #[serde(default)]
    cost: Option<f64>,
}

/// a part as the neutral union. one the daemon's json and the neutral form
/// would tell the reducer different things about stays `unknown`.
#[must_use]
pub fn part(raw: &RawValue) -> Part {
    let neutral = serde_json::from_str::<PartJson>(raw.get())
        .ok()
        .and_then(|json| known(json, raw));
    match neutral {
        Some(part) if facts_agree(&part, raw) => part,
        _ => Part::unknown(raw.to_owned()),
    }
}

fn facts_agree(part: &Part, raw: &RawValue) -> bool {
    let daemon = PartFacts::deserialize(raw).ok();
    daemon.as_ref() == part_facts(part).as_ref()
}

/// where a part sits in its message, from cmx2's id grammar
/// `prt_<session>_<seq>_<index>`; none for any other id.
fn at(id: &str) -> Option<PartAt> {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mut pieces = id.strip_prefix("prt_")?.rsplitn(3, '_');
    let index = pieces.next().filter(|s| digits(s))?.parse().ok()?;
    let step = pieces.next().filter(|s| digits(s))?.parse().ok()?;
    pieces
        .next()
        .filter(|session| !session.is_empty() && !session.contains('_'))?;
    Some(PartAt { step, index })
}

fn part_time(value: &serde_json::Value) -> Option<PartTime> {
    let object = value.as_object()?;
    Some(PartTime {
        start: object.get("start").and_then(serde_json::Value::as_f64),
        end: object.get("end").and_then(serde_json::Value::as_f64),
    })
}

fn known(json: PartJson, raw: &RawValue) -> Option<Part> {
    let at = at(&json.id);
    let streaming = serde_json::from_str::<serde_json::Value>(raw.get())
        .ok()
        .and_then(|v| v.get("streaming").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    Some(match json.kind.as_str() {
        "text" => Part::Text(TextPart {
            id: json.id,
            message_id: json.message_id,
            at,
            text: json.text?,
            streaming,
            time: part_time(&json.time),
            synthetic: json.synthetic,
            notice: false,
            mail: mail(&json.mail),
        }),
        "reasoning" => Part::Reasoning(ReasoningPart {
            id: json.id,
            message_id: json.message_id,
            at,
            text: json.text?,
            streaming,
            time: part_time(&json.time),
        }),
        "tool" => {
            let tool = json.tool?;
            Part::Tool(ToolPart {
                id: json.id,
                message_id: json.message_id,
                at,
                call_id: json.call_id?,
                family: family(&tool),
                tool,
                state: tool_state(&json.state?)?,
            })
        }
        "file" => {
            let mime = json.mime?;
            if IMAGE_KINDS.contains(&mime.as_str()) {
                Part::Image(ImagePart {
                    id: json.id,
                    message_id: json.message_id,
                    at,
                    mime,
                    filename: json.filename,
                    size: None,
                    media: None,
                    url: json.url,
                    width: None,
                    height: None,
                    alt: None,
                    flavour: Flavour::Attached,
                })
            } else {
                Part::File(FilePart {
                    id: json.id,
                    message_id: json.message_id,
                    at,
                    mime,
                    filename: json.filename?,
                    size: None,
                    media: None,
                    url: json.url,
                    flavour: Flavour::Attached,
                })
            }
        }
        "compaction" => Part::Compaction(CompactionPart {
            id: json.id,
            message_id: json.message_id,
            at,
            auto: json.auto?,
            overflow: json.overflow,
        }),
        "step-start" | "step-finish" | "patch" | "subtask" => Part::Marker(MarkerPart {
            id: json.id,
            message_id: json.message_id,
            at,
            marker: match json.kind.as_str() {
                "step-start" => MarkerKind::StepStart,
                "step-finish" => MarkerKind::StepFinish,
                "patch" => MarkerKind::Patch,
                _ => MarkerKind::Subtask,
            },
            cost: json.cost,
        }),
        _ => return None,
    })
}

fn mail(value: &serde_json::Value) -> Option<Mail> {
    let object = value.as_object()?;
    let text = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    Some(Mail {
        kind: text("kind")?,
        from: text("from"),
        from_id: text("fromID"),
    })
}

#[derive(Deserialize)]
struct ToolStateJson {
    status: ToolStatus,
    input: Box<RawValue>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    metadata: Option<Box<RawValue>>,
    #[serde(default)]
    time: Option<ToolTime>,
    #[serde(default)]
    attachments: Option<Vec<Box<RawValue>>>,
    #[serde(default, rename = "attachmentsDropped")]
    attachments_dropped: Option<u32>,
}

fn tool_state(raw: &RawValue) -> Option<ToolState> {
    let state: ToolStateJson = serde_json::from_str(raw.get()).ok()?;
    Some(ToolState {
        status: state.status,
        input: state.input,
        output: state.output,
        title: state.title,
        error: state.error,
        metadata: state.metadata,
        time: state.time,
        attachments: state
            .attachments
            .map(|parts| parts.iter().map(|p| part(p)).collect()),
        attachments_dropped: state.attachments_dropped,
    })
}

/// the family of a cmx2 tool, as the clients name it today
/// (`app/src/ui/thread/model.ts`).
#[must_use]
pub fn family(tool: &str) -> Family {
    match tool {
        "read" => Family::Read,
        "grep" | "glob" | "recall" => Family::Search,
        "edit" | "write" => Family::Edit,
        "shell" | "bash" | "exec_command" | "write_stdin" | "proc_spawn" | "proc_write"
        | "proc_read" | "proc_kill" | "proc_list" => Family::Shell,
        "webfetch" | "websearch" => Family::Web,
        "spawn" | "spawn_agent" | "spawn_pool" => Family::Spawn,
        "message" | "send_message" | "followup_task" => Family::Message,
        "wait" | "wait_agent" => Family::Wait,
        "agents" | "list_agents" | "close_agent" => Family::Agents,
        "question" => Family::Ask,
        "todowrite" => Family::Plan,
        "skill" => Family::Skill,
        other if other.contains("search") => Family::Web,
        _ => Family::Other,
    }
}

/// the ids an ask needs to be held.
#[derive(Deserialize)]
struct AskIds {
    id: String,
    #[serde(rename = "sessionID")]
    session_id: String,
}

/// what an ask says, read as loosely as the reducer read it for its need.
#[derive(Deserialize)]
struct AskWords {
    permission: Option<String>,
    #[serde(default)]
    patterns: Vec<String>,
    #[serde(default)]
    questions: Vec<QuestionWords>,
}

#[derive(Deserialize)]
struct QuestionWords {
    question: String,
}

/// the rest of an ask, for contract 2: read without the power to refuse it.
#[derive(Deserialize, Default)]
struct AskDetail {
    #[serde(default)]
    always: Vec<String>,
    #[serde(default)]
    tool: Option<ToolRefJson>,
    #[serde(default)]
    questions: Vec<QuestionDetail>,
}

#[derive(Deserialize)]
struct ToolRefJson {
    #[serde(rename = "messageID")]
    message_id: String,
    #[serde(rename = "callID")]
    call_id: String,
}

#[derive(Deserialize)]
struct QuestionDetail {
    #[serde(default)]
    header: String,
    #[serde(default)]
    multiple: bool,
    #[serde(default)]
    custom: bool,
    #[serde(default)]
    options: Vec<QuestionOptionJson>,
}

#[derive(Deserialize)]
struct QuestionOptionJson {
    label: String,
    #[serde(default)]
    description: Option<String>,
}

/// an ask request as the daemon wrote it, as an ask of `host`.
///
/// # Errors
/// it lacks its id or its session's.
pub fn ask(host: &str, kind: AskKind, request: &RawValue) -> Result<Ask, serde_json::Error> {
    let ids: AskIds = serde_json::from_str(request.get())?;
    let detail: AskDetail = serde_json::from_str(request.get()).unwrap_or_default();
    let (permission, questions) = match serde_json::from_str::<AskWords>(request.get()) {
        Ok(words) => {
            let permission = words.permission.map(|title| Permission {
                title,
                patterns: words.patterns,
                always: detail.always.clone(),
                options: vec![
                    PermissionOption {
                        id: PermissionReply::Once,
                        label: "allow once".to_owned(),
                        lasting: false,
                    },
                    PermissionOption {
                        id: PermissionReply::Always,
                        label: "always allow".to_owned(),
                        lasting: true,
                    },
                    PermissionOption {
                        id: PermissionReply::Reject,
                        label: "reject".to_owned(),
                        lasting: false,
                    },
                ],
                risk: None,
                warning: None,
                detail: None,
                scope: None,
            });
            let questions: Vec<Question> = words
                .questions
                .into_iter()
                .enumerate()
                .map(|(at, words)| {
                    let more = detail.questions.get(at);
                    Question {
                        question: words.question,
                        header: more.map(|q| q.header.clone()).unwrap_or_default(),
                        multiple: more.is_some_and(|q| q.multiple),
                        custom: more.is_some_and(|q| q.custom),
                        options: more
                            .map(|q| {
                                q.options
                                    .iter()
                                    .map(|o| QuestionOption {
                                        label: o.label.clone(),
                                        description: o.description.clone(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    }
                })
                .collect();
            (permission, (!questions.is_empty()).then_some(questions))
        }
        Err(_) => (None, None),
    };
    let key = format!("{host}:{}", ids.session_id);
    Ok(Ask {
        key: key.clone(),
        agent: host.to_owned(),
        id: ids.id,
        thread: key,
        kind,
        created: None,
        expires: None,
        tool: detail.tool.map(|t| ToolRef {
            message_id: t.message_id,
            call_id: t.call_id,
        }),
        permission,
        questions,
    })
}

/// a fresh read of the host, as the agent's snapshot. what does not decode
/// is skipped with a warning, as the reducer did.
#[must_use]
pub fn snapshot(read: crate::upstream::reconcile::HostRead) -> Snapshot {
    let host = read.host;
    let mut threads = Vec::with_capacity(read.sessions.data.len());
    for info in read.sessions.data {
        match thread_from_json(info) {
            Ok(thread) => threads.push(thread),
            Err(error) => {
                tracing::warn!(host, %error, "a session from the read does not decode; skipped");
            }
        }
    }
    let mut activities = Vec::new();
    for (id, status) in read.statuses.data {
        match cmx2::SessionStatus::deserialize(&*status) {
            Ok(decoded) => {
                let activity = activity(&decoded);
                if activity != Activity::Idle {
                    activities.push(ThreadActivity {
                        thread: id,
                        activity,
                        raw: Some(status),
                    });
                }
            }
            Err(error) => {
                tracing::warn!(host, session = id, %error, "a status from the read does not decode; skipped");
            }
        }
    }
    let mut asks = Vec::new();
    for (kind, requests) in [
        (AskKind::Permission, read.permissions.data),
        (AskKind::Question, read.questions.data),
    ] {
        for request in requests {
            match ask(&host, kind, &request) {
                Ok(ask) => asks.push(RaisedAsk {
                    ask,
                    raw: Some(request),
                }),
                Err(error) => {
                    tracing::warn!(host, %error, "an ask from the read does not decode; skipped");
                }
            }
        }
    }
    Snapshot {
        epoch: Some(read.epoch),
        floors: Floors {
            threads: read.sessions.seq,
            activities: read.statuses.seq,
            permissions: read.permissions.seq,
            questions: read.questions.seq,
        },
        threads,
        activities,
        asks,
    }
}

/// the decoded answer of `GET /session/:id/message`, as a tail read: a
/// message whose info does not decode is skipped, as before.
///
/// # Errors
/// the answer is not a list of `{info, parts}`.
pub fn tail(thread: String, upstream: Stamp, body: &[u8]) -> Result<TailRead, serde_json::Error> {
    #[derive(Deserialize)]
    struct RawMessage<'a> {
        #[serde(borrow)]
        info: &'a RawValue,
        #[serde(borrow)]
        parts: Vec<&'a RawValue>,
    }
    let raw: Vec<RawMessage<'_>> = serde_json::from_slice(body)?;
    let messages = raw
        .into_iter()
        .filter_map(|m| {
            let info = message(m.info).ok()?;
            let parts = m.parts.into_iter().map(part).collect();
            Some(MessageWithParts { info, parts })
        })
        .collect();
    Ok(TailRead {
        thread,
        upstream: Some(upstream),
        messages,
    })
}

#[cfg(test)]
mod tests;
