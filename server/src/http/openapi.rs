//! boxbox's own api, described with utoipa. `boxbox openapi` prints it,
//! `app/src/api/boxbox.json` is that output committed, and the app's
//! client types are generated from it; `just check` fails on drift.

use utoipa::OpenApi;

use super::asks::{Done, PermissionAnswer, PermissionReply, Prompt, QuestionAnswer, Verb};
use super::compose::{
    Born, CommandChoice, Folder, Folders, NewThread, Photo, Place, ProjectChoice, Shell,
    SlashCommand, Steer,
};
use super::error::{CheckoutRefusal, ErrorBody, ErrorDetail, RefusalKind, SettledBy};
use super::history::{HistoryPage, HistoryRow, Unreached};
use super::hosts::{HostModels, McpServer, ModelChoice, Pair, PairedHost, Reloaded, Restarting};
use super::login::{Login, Session};
use super::needs::{NeedsList, ReadBody};
use super::push::{
    PushDevice, PushState, PushTest, Subscribe, SubscriptionKeys, TestQueued, Unsubscribe,
    Unsubscribed,
};
use super::review::{MergeBody, WorktreeDiscarded, WorktreeFile, WorktreeMerged, WorktreeReview};
use super::session::{ModelRef, Send, SendPart};
use super::telemetry::{Accepted, TelemetryBatch};
use super::threads::{Archived, ClearBody, ClearSource, Cleared, NotCleared, NotClearedWhy};
use crate::config::Origin;
use crate::fleet::change::{
    Ask, AskKind, Change, Control, FleetSnapshot, JournalEntry, ResetReason, SessionEntry,
    StreamFrame, TailItem, TailKind,
};
use crate::fleet::needs::{By, How, Need, NeedKind};
use crate::fleet::read::ReadMark;
use crate::prefs::{DevicePrefs, ModelPrefs, Motion, Prefs, RepoPrefs, Theme};
use crate::pty::routes::{NewTerminal, TerminalChange, TerminalSize};
use crate::push::Kind;
use crate::push::presence::Report;
use crate::upstream::system::{Cpu, Daemon, Disk, Machine, MemoryUse, Os};
use crate::upstream::{Connection, FrameCounts, Health, HostStatus, Memory, System};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "boxbox",
        description = "the boxbox server: a password gate, the hosts it watches, the fleet as one stream with a cursor, transcripts read through it, the verbs a person answers asks and starts turns with (each with a clientID), the rest of a session's write path (queue, steer, commands, shells, unsend), terminals relayed through it, push and presence, needs and read state, and the telemetry ingest. every route but login and logout needs the session cookie.",
        license(name = "MIT"),
    ),
    paths(
        super::login::login,
        super::login::logout,
        super::hosts::list,
        super::hosts::pair,
        super::hosts::forget,
        super::hosts::reload,
        super::hosts::restart,
        super::hosts::models,
        super::prefs::all,
        super::prefs::device,
        super::prefs::repo,
        super::prefs::favorite_models,
        super::stream::stream,
        super::fleet::snapshot,
        super::transcript::messages,
        super::transcript::message,
        super::review::show,
        super::review::merge,
        super::review::discard,
        super::session::queue,
        super::session::run_now,
        super::session::unsend,
        super::session::providers,
        super::session::find_file,
        super::repo_icon::repo_icon,
        super::media::upload,
        super::media::serve,
        super::push::state,
        super::push::subscribe,
        super::push::unsubscribe,
        super::push::test,
        super::push::presence,
        super::history::page,
        super::threads::clear,
        super::threads::archive,
        super::threads::adopt,
        super::needs::list,
        super::needs::read,
        super::asks::permission,
        super::asks::question,
        super::asks::reject,
        super::asks::prompt,
        super::asks::abort,
        super::asks::compact,
        super::compose::steer,
        super::compose::shell,
        super::compose::command,
        super::compose::commands,
        super::compose::projects,
        super::compose::folders,
        super::compose::start,
        super::telemetry::ingest,
        crate::pty::routes::list,
        crate::pty::routes::shells,
        crate::pty::routes::create,
        crate::pty::routes::one,
        crate::pty::routes::update,
        crate::pty::routes::kill,
        crate::pty::routes::connect,
    ),
    components(schemas(
        Accepted,
        crate::media::MediaObject,
        Archived,
        CheckoutRefusal,
        MergeBody,
        RefusalKind,
        WorktreeDiscarded,
        WorktreeFile,
        WorktreeMerged,
        WorktreeReview,
        Ask,
        AskKind,
        By,
        Done,
        How,
        Need,
        NeedKind,
        NeedsList,
        PermissionAnswer,
        PermissionReply,
        Prompt,
        Photo,
        Steer,
        Shell,
        SlashCommand,
        NewThread,
        Place,
        Born,
        CommandChoice,
        Folder,
        Folders,
        ProjectChoice,
        QuestionAnswer,
        ReadBody,
        ClearBody,
        ClearSource,
        Cleared,
        NotCleared,
        NotClearedWhy,
        HistoryPage,
        HistoryRow,
        Unreached,
        ReadMark,
        SettledBy,
        Verb,
        Change,
        Connection,
        Control,
        ModelRef,
        Send,
        SendPart,
        ErrorBody,
        ErrorDetail,
        FleetSnapshot,
        FrameCounts,
        Health,
        HostStatus,
        HostModels,
        McpServer,
        Memory,
        System,
        Os,
        Machine,
        Cpu,
        MemoryUse,
        Disk,
        Daemon,
        ModelChoice,
        Motion,
        Origin,
        Pair,
        PairedHost,
        Prefs,
        DevicePrefs,
        ModelPrefs,
        RepoPrefs,
        Reloaded,
        Restarting,
        Theme,
        JournalEntry,
        Kind,
        Login,
        PushDevice,
        PushState,
        PushTest,
        Report,
        NewTerminal,
        ResetReason,
        Session,
        SessionEntry,
        StreamFrame,
        Subscribe,
        SubscriptionKeys,
        TailItem,
        TailKind,
        TelemetryBatch,
        TestQueued,
        Unsubscribe,
        Unsubscribed,
        TerminalChange,
        TerminalSize,
    ))
)]
pub struct ApiDoc;

/// the document as pretty json with a trailing newline, byte-stable.
///
/// # Errors
/// serialization failed, which only a utoipa bug could cause.
pub fn document() -> Result<String, serde_json::Error> {
    let mut doc = ApiDoc::openapi();
    // the crate's version would make every release a drift; the api has
    // its own version, bumped when the contract changes
    doc.info.version = "1".into();
    doc.to_pretty_json().map(|json| json + "\n")
}
