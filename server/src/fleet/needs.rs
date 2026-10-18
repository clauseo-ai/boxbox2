//! needs: what waits on a person, derived once here from the journal and
//! rendered by every surface (decision 16; `design.md`, the order is the
//! inbox). the fleet model raises a need when the daemon says something
//! happened that a person must answer or should see, and serves it when
//! that is done, recording who served it and when.
//!
//! the ledger is pure: the model hands it the time, and it keeps no clock.
//! open needs live in a map keyed by id; the ones served lately stay in a
//! short ring, so a surface can say "answered on your mac at 23:49" and
//! `GET /api/needs` can show what just left. both are mirrored to
//! `boxbox.db` by the actor, so a restart forgets nothing and never raises
//! a need twice (`scars.md`: brain memory lives in one process).

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;
use utoipa::ToSchema;

/// needs held open at once. one person has a handful; past this the
/// oldest non-ask need is dropped as expired (every map has an eviction
/// rule).
pub const MAX_OPEN: usize = 500;
/// served needs kept for surfaces that say who served them and when.
pub const MAX_SERVED: usize = 200;
/// characters of a need's body; a banner shows fewer.
pub const BODY_CHARS: usize = 240;

/// what a need is about. the names are the telemetry `need` values and
/// never change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, serde::Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NeedKind {
    /// the agent wants to run something and waits for a yes.
    Permission,
    /// the agent asked a question and waits for the answer.
    Question,
    /// a turn died without the person: the daemon's error, or a turn cut
    /// off that nobody stopped.
    Fault,
    /// the agent in a checkout says its work is ready to look at.
    Review,
    /// a background job reported (it exited, printed what it watched for,
    /// opened a port).
    Job,
    /// a turn finished and nobody has seen it yet.
    Done,
}

impl NeedKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Fault => "fault",
            Self::Review => "review",
            Self::Job => "job",
            Self::Done => "done",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "permission" => Self::Permission,
            "question" => Self::Question,
            "fault" => Self::Fault,
            "review" => Self::Review,
            "job" => Self::Job,
            "done" => Self::Done,
            _ => return None,
        })
    }

    /// the need's place in the inbox (`design.md`, the order is the inbox):
    /// 0 wants you, oldest first; 1 failed; 2 done, unseen (a review and a
    /// job notice are news of the same weight), newest first.
    #[must_use]
    pub fn rank(self) -> u8 {
        match self {
            Self::Permission | Self::Question => 0,
            Self::Fault => 1,
            Self::Review | Self::Job | Self::Done => 2,
        }
    }

    /// whether it is an ask: served only by its answer.
    #[must_use]
    pub fn is_ask(self) -> bool {
        matches!(self, Self::Permission | Self::Question)
    }
}

/// how a need was served. the names are telemetry values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum How {
    /// an ask was answered (or rejected by a person).
    Answered,
    /// the thread was looked at, on stage on a looking device, or marked read.
    Seen,
    /// a new turn started in the session: a retry, a reply, the agent
    /// carrying on.
    Continued,
    /// a checkout was merged or discarded.
    Settled,
    /// the daemon dropped it: a turn aborted, a session ended, a restart.
    Dropped,
    /// the session went away.
    Gone,
    /// the ledger was full and it was the oldest.
    Expired,
}

impl How {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Seen => "seen",
            Self::Continued => "continued",
            Self::Settled => "settled",
            Self::Dropped => "dropped",
            Self::Gone => "gone",
            Self::Expired => "expired",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "answered" => Self::Answered,
            "seen" => Self::Seen,
            "continued" => Self::Continued,
            "settled" => Self::Settled,
            "dropped" => Self::Dropped,
            "gone" => Self::Gone,
            "expired" => Self::Expired,
            _ => return None,
        })
    }
}

/// who served a need: a person on one of their devices, a person somewhere
/// boxbox cannot name (another client of the daemon), or nobody (the agent
/// moved on, the daemon dropped it).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize, ToSchema)]
#[serde(tag = "by", rename_all = "lowercase")]
pub enum By {
    /// a boxbox device, by its id, with the class it named itself by
    /// ("iphone", "mac") so a surface can say where.
    Device {
        device: String,
        #[serde(rename = "deviceClass")]
        class: String,
    },
    /// a person, through a client that is not boxbox; the daemon's `by`.
    Elsewhere { who: String },
    /// nobody: the agent or the daemon.
    Agent,
}

impl By {
    /// a person served it (telemetry `need.served`); otherwise it cleared
    /// (`need.cleared`, by agent or expired).
    #[must_use]
    pub fn is_person(&self) -> bool {
        !matches!(self, Self::Agent)
    }

    /// the telemetry `by` prop.
    #[must_use]
    pub fn label(&self) -> &str {
        match self {
            Self::Device { device, .. } => device,
            Self::Elsewhere { who } => who,
            Self::Agent => "agent",
        }
    }
}

/// one need, open or served.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Need {
    /// stable per event: `ask:<host>:<ask id>`, `done:<key>:<message id>`,
    /// `fault:<key>:<message id or seq>`, `review:<key>:<checkout>:<event seq or t<ms>>` (one per request),
    /// `job:<key>:<process id>:<reason>`. the push notice for it carries
    /// the same id.
    pub id: String,
    pub kind: NeedKind,
    /// the session, `<host>:<sessionID>`.
    pub key: String,
    /// its place in the inbox: 0 wants you, 1 failed, 2 done or news.
    pub rank: u8,
    /// when boxbox raised it, ms since the epoch on the server's clock.
    pub raised_at: i64,
    /// "ledger wants you", "api is done", in the voice.
    pub title: String,
    /// the question, the command it wants to run, the result line, the
    /// reason; at most 240 characters.
    pub body: String,
    /// the ask's id, on a permission or a question.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
    /// the checkout's name, on a review.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout: Option<String>,
    /// when it was served; absent while open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub served_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub served_by: Option<By>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub how: Option<How>,
}

impl Need {
    /// a need about to be raised; the ledger stamps its rank.
    #[must_use]
    pub fn new(
        id: String,
        kind: NeedKind,
        key: &str,
        raised_at: i64,
        title: String,
        body: &str,
    ) -> Self {
        Self {
            id,
            kind,
            key: key.to_owned(),
            rank: kind.rank(),
            raised_at,
            title,
            body: first_chars(body.trim(), BODY_CHARS),
            ask: None,
            checkout: None,
            served_at: None,
            served_by: None,
            how: None,
        }
    }

    /// where it sorts in the inbox (`sort_key`), for a surface that ranks
    /// needs itself.
    #[must_use]
    pub fn inbox_key(&self) -> (u8, i64) {
        self.sort_key()
    }

    /// the order within the inbox: rank, then oldest ask first, newest
    /// news first.
    fn sort_key(&self) -> (u8, i64) {
        let at = if self.rank == 0 {
            self.raised_at
        } else {
            -self.raised_at
        };
        (self.rank, at)
    }
}

/// what happened to the ledger, for the actor to publish, persist and
/// count.
#[derive(Clone, Debug, PartialEq)]
pub enum Moved {
    Raised(Need),
    Served(Need),
}

#[derive(Debug, Default)]
pub struct Needs {
    open: HashMap<String, Need>,
    served: VecDeque<Need>,
    /// ids ever raised that are no longer open, so a replay or a reread
    /// never raises one again. bounded with `served` (the store keeps the
    /// rest, and reloads it at start).
    known: HashSet<String>,
}

impl Needs {
    /// the ledger as the store left it: open needs, and the served ones
    /// newest last.
    #[must_use]
    pub fn restore(open: Vec<Need>, served: Vec<Need>) -> Self {
        let mut needs = Self::default();
        for need in served {
            needs.remember(need);
        }
        for need in open {
            needs.open.insert(need.id.clone(), need);
        }
        needs
    }

    /// raises `need` unless one with its id is open or was ever served.
    pub fn raise(&mut self, need: Need, moved: &mut Vec<Moved>) -> bool {
        if self.open.contains_key(&need.id) || self.known.contains(&need.id) {
            return false;
        }
        if self.open.len() >= MAX_OPEN {
            self.expire_oldest(need.raised_at, moved);
        }
        moved.push(Moved::Raised(need.clone()));
        self.open.insert(need.id.clone(), need);
        true
    }

    /// serves the open need `id`; nothing when it is not open.
    pub fn serve(
        &mut self,
        id: &str,
        by: By,
        how: How,
        at: i64,
        moved: &mut Vec<Moved>,
    ) -> Option<&Need> {
        let mut need = self.open.remove(id)?;
        need.served_at = Some(at.max(need.raised_at));
        need.served_by = Some(by);
        need.how = Some(how);
        moved.push(Moved::Served(need.clone()));
        self.remember(need);
        self.served.back()
    }

    /// serves every open need of `key` that `matches` picks; returns how many.
    pub fn serve_where(
        &mut self,
        key: &str,
        matches: impl Fn(&Need) -> bool,
        by: &By,
        how: How,
        at: i64,
        moved: &mut Vec<Moved>,
    ) -> usize {
        let mut ids: Vec<String> = self
            .open
            .values()
            .filter(|n| n.key == key && matches(n))
            .map(|n| n.id.clone())
            .collect();
        // in id order, not the map's: the served list and its effects come out the same every run
        ids.sort_unstable();
        for id in &ids {
            self.serve(id, by.clone(), how, at, moved);
        }
        ids.len()
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<&Need> {
        self.open.get(id)
    }

    #[must_use]
    pub fn is_known(&self, id: &str) -> bool {
        self.open.contains_key(id) || self.known.contains(id)
    }

    /// the open needs of one session, in inbox order.
    #[must_use]
    pub fn of(&self, key: &str) -> Vec<Need> {
        let mut needs: Vec<Need> = self
            .open
            .values()
            .filter(|n| n.key == key)
            .cloned()
            .collect();
        needs.sort_by_key(Need::sort_key);
        needs
    }

    /// the session's most pressing need: its rank and the time it sorts by.
    #[must_use]
    pub fn lead(&self, key: &str) -> Option<(u8, i64)> {
        self.open
            .values()
            .filter(|n| n.key == key)
            .map(Need::sort_key)
            .min()
    }

    /// every open need, in no order.
    pub fn open_iter(&self) -> impl Iterator<Item = &Need> {
        self.open.values()
    }

    /// every open need, in inbox order.
    #[must_use]
    pub fn open(&self) -> Vec<Need> {
        let mut needs: Vec<Need> = self.open.values().cloned().collect();
        needs.sort_by(|a, b| {
            a.sort_key()
                .cmp(&b.sort_key())
                .then_with(|| a.id.cmp(&b.id))
        });
        needs
    }

    /// the served needs, newest first, at most `limit`.
    #[must_use]
    pub fn served(&self, limit: usize) -> Vec<Need> {
        self.served.iter().rev().take(limit).cloned().collect()
    }

    /// sessions with an open need: the app icon's badge.
    #[must_use]
    pub fn sessions_waiting(&self) -> usize {
        let mut keys: Vec<&str> = self.open.values().map(|n| n.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        keys.len()
    }

    #[must_use]
    pub fn open_count(&self) -> usize {
        self.open.len()
    }

    /// drops what a host held, without serving it: the host left the config.
    pub fn forget_host(&mut self, host: &str) {
        let prefix = format!("{host}:");
        self.open.retain(|_, n| !n.key.starts_with(&prefix));
    }

    fn remember(&mut self, need: Need) {
        self.known.insert(need.id.clone());
        self.served.push_back(need);
        while self.served.len() > MAX_SERVED {
            if let Some(old) = self.served.pop_front() {
                self.known.remove(&old.id);
            }
        }
    }

    fn expire_oldest(&mut self, at: i64, moved: &mut Vec<Moved>) {
        let oldest = self
            .open
            .values()
            .filter(|n| !n.kind.is_ask())
            .min_by(|a, b| a.raised_at.cmp(&b.raised_at).then_with(|| a.id.cmp(&b.id)))
            .map(|n| n.id.clone());
        if let Some(id) = oldest {
            self.serve(&id, By::Agent, How::Expired, at, moved);
        }
    }
}

/// the first `count` characters, never splitting one.
#[must_use]
pub fn first_chars(text: &str, count: usize) -> String {
    match text.char_indices().nth(count) {
        Some((at, _)) => text[..at].to_owned(),
        None => text.to_owned(),
    }
}

/// the last sentence of `text`, for a "done" body: "118 passed. all four
/// new tests..." reads better than the whole answer.
#[must_use]
pub fn last_sentences(text: &str, count: usize) -> String {
    let text = text.trim();
    let mut ends: Vec<usize> = text
        .char_indices()
        .filter(|(at, c)| {
            matches!(c, '.' | '!' | '?' | '\n')
                && text[at + c.len_utf8()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        })
        .map(|(at, c)| at + c.len_utf8())
        .collect();
    // the text's own end is not a boundary to start from
    if ends.last() == Some(&text.len()) {
        ends.pop();
    }
    let start = ends.len().checked_sub(count).map_or(0, |i| ends[i]);
    text[start..].trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn need(id: &str, kind: NeedKind, key: &str, at: i64) -> Need {
        Need::new(
            id.into(),
            kind,
            key,
            at,
            format!("{key} wants you"),
            "which greeting?",
        )
    }

    fn device(id: &str) -> By {
        By::Device {
            device: id.into(),
            class: "iphone".into(),
        }
    }

    #[test]
    fn the_inbox_puts_asks_first_oldest_first_then_faults_then_news_newest_first() {
        let mut needs = Needs::default();
        let mut moved = Vec::new();
        for n in [
            need("done:a", NeedKind::Done, "d:a", 10),
            need("ask:new", NeedKind::Question, "d:b", 30),
            need("fault:c", NeedKind::Fault, "d:c", 5),
            need("ask:old", NeedKind::Permission, "d:d", 20),
            need("review:e", NeedKind::Review, "d:e", 40),
        ] {
            assert!(needs.raise(n, &mut moved));
        }
        let ids: Vec<String> = needs.open().into_iter().map(|n| n.id).collect();
        assert_eq!(ids, ["ask:old", "ask:new", "fault:c", "review:e", "done:a"]);
        assert_eq!(needs.lead("d:b"), Some((0, 30)));
        assert_eq!(needs.sessions_waiting(), 5);
    }

    #[test]
    fn a_need_is_raised_once_even_after_it_was_served() {
        let mut needs = Needs::default();
        let mut moved = Vec::new();
        assert!(needs.raise(need("ask:q1", NeedKind::Question, "d:s", 1), &mut moved));
        assert!(!needs.raise(need("ask:q1", NeedKind::Question, "d:s", 2), &mut moved));
        needs.serve("ask:q1", device("phone"), How::Answered, 9, &mut moved);
        assert!(!needs.raise(need("ask:q1", NeedKind::Question, "d:s", 3), &mut moved));
        assert_eq!(moved.len(), 2);
        let Moved::Served(served) = &moved[1] else {
            unreachable!()
        };
        assert_eq!(
            (served.served_at, served.how),
            (Some(9), Some(How::Answered))
        );
        assert_eq!(needs.served(10)[0].id, "ask:q1");
    }

    #[test]
    fn serving_a_session_takes_only_what_the_rule_picks() {
        let mut needs = Needs::default();
        let mut moved = Vec::new();
        needs.raise(need("done:1", NeedKind::Done, "d:s", 1), &mut moved);
        needs.raise(need("ask:1", NeedKind::Question, "d:s", 2), &mut moved);
        needs.raise(need("done:2", NeedKind::Done, "d:t", 3), &mut moved);
        let served = needs.serve_where(
            "d:s",
            |n| !n.kind.is_ask(),
            &device("mac"),
            How::Seen,
            5,
            &mut moved,
        );
        assert_eq!(served, 1);
        let open: Vec<String> = needs.open().into_iter().map(|n| n.id).collect();
        assert_eq!(open, ["ask:1", "done:2"]);
    }

    #[test]
    fn a_full_ledger_expires_the_oldest_news_never_an_ask() {
        let mut needs = Needs::default();
        let mut moved = Vec::new();
        needs.raise(need("ask:first", NeedKind::Question, "d:a", 0), &mut moved);
        for n in 1..MAX_OPEN {
            let at = i64::try_from(n).unwrap();
            needs.raise(
                need(&format!("done:{n}"), NeedKind::Done, "d:b", at),
                &mut moved,
            );
        }
        needs.raise(need("done:last", NeedKind::Done, "d:b", 10_000), &mut moved);
        assert_eq!(needs.open_count(), MAX_OPEN);
        assert!(needs.get("ask:first").is_some());
        assert!(needs.get("done:1").is_none());
    }

    #[test]
    fn restoring_keeps_served_ids_known_and_open_needs_open() {
        let mut served = need("done:x", NeedKind::Done, "d:s", 1);
        served.served_at = Some(2);
        let needs = Needs::restore(
            vec![need("ask:y", NeedKind::Question, "d:s", 3)],
            vec![served],
        );
        assert!(needs.is_known("done:x"));
        assert_eq!(needs.open()[0].id, "ask:y");
    }

    #[test]
    fn a_body_keeps_its_last_sentences_and_fits_a_banner() {
        assert_eq!(
            last_sentences("ran the suite. 118 passed. all four new tests pass.", 2),
            "118 passed. all four new tests pass."
        );
        assert_eq!(last_sentences("no stop at all", 1), "no stop at all");
        assert_eq!(last_sentences("v1.2 is out.", 1), "v1.2 is out.");
        let long = Need::new(
            "x".into(),
            NeedKind::Done,
            "d:s",
            0,
            "t".into(),
            &"é".repeat(300),
        );
        assert_eq!(long.body.chars().count(), BODY_CHARS);
    }
}

/// how long served needs stay in the store.
pub const KEEP_SERVED_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// the ledger the store kept: open needs, and the newest served ones
/// oldest first. served needs past `KEEP_SERVED_MS` are pruned first.
///
/// # Errors
/// sqlite's.
pub fn load(
    connection: &rusqlite::Connection,
    now: i64,
) -> rusqlite::Result<(Vec<Need>, Vec<Need>)> {
    connection.execute(
        "DELETE FROM needs WHERE served_at IS NOT NULL AND served_at < ?1",
        [now - KEEP_SERVED_MS],
    )?;
    let columns = "id, kind, session, raised_at, title, body, ask, checkout, served_at, how, by_kind, by_who, by_class";
    let read = |sql: &str| -> rusqlite::Result<Vec<Need>> {
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map([], row_to_need)?;
        Ok(rows.filter_map(Result::ok).flatten().collect())
    };
    let open = read(&format!(
        "SELECT {columns} FROM needs WHERE served_at IS NULL"
    ))?;
    let mut served = read(&format!(
        "SELECT {columns} FROM needs WHERE served_at IS NOT NULL ORDER BY served_at DESC LIMIT {MAX_SERVED}"
    ))?;
    served.reverse();
    Ok((open, served))
}

/// a row a later build wrote with a kind this one does not know is skipped.
fn row_to_need(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Need>> {
    let kind: String = row.get(1)?;
    let Some(kind) = NeedKind::parse(&kind) else {
        return Ok(None);
    };
    let how: Option<String> = row.get(9)?;
    let by_kind: Option<String> = row.get(10)?;
    let by_who: Option<String> = row.get(11)?;
    let by_class: Option<String> = row.get(12)?;
    let served_by = match (by_kind.as_deref(), by_who) {
        (Some("device"), Some(device)) => Some(By::Device {
            device,
            class: by_class.unwrap_or_default(),
        }),
        (Some("elsewhere"), Some(who)) => Some(By::Elsewhere { who }),
        (Some("agent"), _) => Some(By::Agent),
        _ => None,
    };
    Ok(Some(Need {
        id: row.get(0)?,
        kind,
        key: row.get(2)?,
        rank: kind.rank(),
        raised_at: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        ask: row.get(6)?,
        checkout: row.get(7)?,
        served_at: row.get(8)?,
        served_by,
        how: how.as_deref().and_then(How::parse),
    }))
}

/// writes a need as it stands: raised, or served.
///
/// # Errors
/// sqlite's.
pub fn save(connection: &rusqlite::Connection, need: &Need) -> rusqlite::Result<()> {
    let (by_kind, by_who, by_class) = match &need.served_by {
        Some(By::Device { device, class }) => {
            (Some("device"), Some(device.as_str()), Some(class.as_str()))
        }
        Some(By::Elsewhere { who }) => (Some("elsewhere"), Some(who.as_str()), None),
        Some(By::Agent) => (Some("agent"), None, None),
        None => (None, None, None),
    };
    connection.execute(
        "INSERT INTO needs (id, kind, session, raised_at, title, body, ask, checkout, served_at, how, by_kind, by_who, by_class)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (id) DO UPDATE SET
             served_at = excluded.served_at, how = excluded.how, by_kind = excluded.by_kind,
             by_who = excluded.by_who, by_class = excluded.by_class",
        rusqlite::params![
            need.id,
            need.kind.as_str(),
            need.key,
            need.raised_at,
            need.title,
            need.body,
            need.ask,
            need.checkout,
            need.served_at,
            need.how.map(How::as_str),
            by_kind,
            by_who,
            by_class,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod store_tests {
    use super::*;

    #[test]
    fn the_ledger_round_trips_through_the_store_and_old_served_rows_are_pruned() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        let mut open = Need::new(
            "ask:d:q1".into(),
            NeedKind::Question,
            "d:s",
            10,
            "t".into(),
            "b",
        );
        open.ask = Some("q1".into());
        save(&connection, &open).unwrap();
        let mut served = Need::new(
            "done:d:s:m1".into(),
            NeedKind::Done,
            "d:s",
            5,
            "t".into(),
            "b",
        );
        save(&connection, &served).unwrap();
        served.served_at = Some(8);
        served.served_by = Some(By::Device {
            device: "phone".into(),
            class: "iphone".into(),
        });
        served.how = Some(How::Seen);
        save(&connection, &served).unwrap();
        let mut stale = Need::new(
            "done:d:s:m0".into(),
            NeedKind::Done,
            "d:s",
            1,
            "t".into(),
            "b",
        );
        stale.served_at = Some(2);
        stale.served_by = Some(By::Agent);
        save(&connection, &stale).unwrap();

        let (loaded_open, loaded_served) = load(&connection, KEEP_SERVED_MS + 5).unwrap();
        assert_eq!(loaded_open, vec![open]);
        assert_eq!(loaded_served, vec![served]);
    }
}
