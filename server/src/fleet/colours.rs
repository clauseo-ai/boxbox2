//! repo colours (decision 82; `docs/design.md`, colour): which of the ten
//! repo hues each repo wears. a repo is a host plus its root, the checkout
//! its worktrees share (`source/cmx2/translate.rs`, `ThreadFacts::place`),
//! and every window, thread and chip of it wears that one colour on every
//! device.
//!
//! the server hands the colours out per host and remembers them. the first
//! time the fleet shows a session whose repo has no colour, the repo gets
//! one of the colours its host's repos wear least; of those, the one its
//! hash names (`fnv1a(host:root) % 10`, the same function and order as
//! `app/src/ui/window/repo.ts`) when that is among them, else the lowest
//! slot. so ten repos on a host never share, and a repo keeps the colour
//! the hash always gave it unless another repo wears it already. a host
//! read gives its new repos colours most threads first, then by root, so on
//! an install from before this the busiest repos keep the colour they had
//! and only the ones that clashed move.
//!
//! a person may choose a repo's colour (`PUT /api/prefs/colours`).
//! automatic shows the one boxbox gave it again and never picks a new one:
//! the colour shown is `chosen ?? auto`.
//!
//! the model owns the rows in memory and gives colours inside the actor's
//! step, so two sessions of a new repo arriving together cannot both give
//! it one. the actor mirrors every row to `boxbox.db`'s `prefs` table:
//! scope `colour`, subject `host:root`, value `{"auto": name, "chosen":
//! name | null}`. rows are read leniently: a name this build does not know
//! reads as the repo's hash colour, and a row that does not parse is warned
//! about and skipped, so its repo is given a colour again when it is seen.
//!
//! eviction: at most `MAX_COLOURS` rows, which is `model::MAX_SESSIONS`, so
//! every repo the fleet holds a session of always fits. past it the row
//! that goes is one no session in the fleet uses, automatic before chosen,
//! the longest unused first; a row in use never goes. a row's last use is
//! its last change or the last host read or session change that showed the repo (written at
//! most daily), so a restart that finds the table over the cap trims the
//! repos nobody has worked in lately, never the busy ones. this scope is not under the prefs table's
//! per scope cap (`prefs.rs`): the model is its only owner, so other
//! preferences never push a colour out.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::wire::RepoColour;

/// rows kept across every host: one per repo the fleet can hold a session of.
pub const MAX_COLOURS: usize = super::model::MAX_SESSIONS;

/// a row's last use is written again at most this often, ms.
const SEEN_EVERY_MS: i64 = 24 * 60 * 60 * 1000;

/// the `prefs` scope the rows live in.
pub const SCOPE: &str = "colour";

/// the ten repo colours by name, in the order of `REPO_COLOURS` in
/// `app/src/ui/window/repo.ts`: a slot is an index into both.
pub const NAMES: [&str; 10] = [
    "green", "violet", "rose", "cobalt", "blue", "teal", "sunset", "plum", "magenta", "slate",
];

/// 32-bit fnv-1a over the text's utf-16 code units, as `fnv1a` in
/// `app/src/ui/window/repo.ts` hashes a javascript string, so both agree
/// on every root, ascii or not.
#[must_use]
pub fn fnv1a(text: &str) -> u32 {
    text.encode_utf16().fold(0x811c_9dc5, |hash: u32, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193)
    })
}

/// the slot the repo's hash names.
#[must_use]
pub fn hashed(host: &str, root: &str) -> u8 {
    // below ten, so it fits
    u8::try_from(fnv1a(&format!("{host}:{root}")) % 10).unwrap_or(0)
}

/// a repo colour's slot by its name.
#[must_use]
pub fn slot(name: &str) -> Option<u8> {
    NAMES
        .iter()
        .position(|n| *n == name)
        .and_then(|at| u8::try_from(at).ok())
}

fn name(slot: u8) -> &'static str {
    NAMES.get(usize::from(slot)).copied().unwrap_or(NAMES[0])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Row {
    auto: u8,
    chosen: Option<u8>,
    /// when the row last changed or a host read or session change last showed the repo, ms on
    /// the server's clock: its last use, which the cap evicts by.
    at: i64,
}

impl Row {
    fn shown(self) -> u8 {
        self.chosen.unwrap_or(self.auto)
    }
}

/// the row as `boxbox.db` keeps it.
#[derive(Serialize, Deserialize)]
struct Value {
    auto: String,
    #[serde(default)]
    chosen: Option<String>,
}

/// the repos the fleet holds a session of: roots by host.
pub type InUse = HashMap<String, HashSet<String>>;

/// the longest subject the `prefs` table holds, in characters (its CHECK).
pub const SUBJECT_MAX: usize = 1024;

/// whether the table can hold the repo's row; counted in bytes, which are
/// never fewer than characters.
#[must_use]
pub fn keepable(host: &str, root: &str) -> bool {
    host.len() + 1 + root.len() <= SUBJECT_MAX
}

/// a row as the store kept it: its subject, its json, when it last changed.
pub type Kept = (String, String, i64);

/// one write for the store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Write {
    Put {
        host: String,
        root: String,
        value: String,
        at: i64,
    },
    Remove {
        host: String,
        root: String,
    },
}

#[derive(Debug, Default)]
pub struct Colours {
    /// by host, then root.
    rows: HashMap<String, BTreeMap<String, Row>>,
    len: usize,
    /// whether the fleet gives a new repo a colour by itself. a model made for
    /// a test of something else leaves it off, as does the replay of contract
    /// 1's recording, which predates colours (`replay/tests.rs`).
    assigning: bool,
}

impl Colours {
    /// the rows the store kept, the `MAX_COLOURS` used last, and the
    /// subjects of the older ones, which the caller deletes so the table holds
    /// no more than the map. a row that does not read is warned about and left
    /// out.
    #[must_use]
    pub fn restore(kept: Vec<Kept>) -> (Self, Vec<String>) {
        let mut read = Vec::with_capacity(kept.len());
        for (subject, value, at) in kept {
            let Some((host, root)) = subject.split_once(':') else {
                warn!(%subject, "a repo colour names no host; left out");
                continue;
            };
            let value = match serde_json::from_str::<Value>(&value) {
                Ok(value) => value,
                Err(error) => {
                    warn!(%subject, %error, "a repo colour does not read; the repo gets one again when it is seen");
                    continue;
                }
            };
            let hash = hashed(host, root);
            let known = |name: &str| {
                slot(name).unwrap_or_else(|| {
                    warn!(%subject, colour = name, "a repo colour this build does not know; the repo shows its hash colour");
                    hash
                })
            };
            let row = Row {
                auto: known(&value.auto),
                chosen: value.chosen.as_deref().map(known),
                at,
            };
            let colon = host.len();
            read.push((subject, colon, row));
        }
        read.sort_by(|a, b| b.2.at.cmp(&a.2.at).then_with(|| a.0.cmp(&b.0)));
        let dropped = if read.len() > MAX_COLOURS {
            read.split_off(MAX_COLOURS)
                .into_iter()
                .map(|(subject, ..)| subject)
                .collect()
        } else {
            Vec::new()
        };
        let mut colours = Self {
            assigning: true,
            ..Self::default()
        };
        for (subject, colon, row) in read {
            let (host, root) = (&subject[..colon], &subject[colon + 1..]);
            colours.insert(host, root, row);
        }
        (colours, dropped)
    }

    /// colours with no rows that give new repos colours: a fresh install.
    #[cfg(test)]
    #[must_use]
    pub fn assigning() -> Self {
        Self {
            assigning: true,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn is_assigning(&self) -> bool {
        self.assigning
    }

    #[must_use]
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[must_use]
    pub fn has(&self, host: &str, root: &str) -> bool {
        self.row(host, root).is_some()
    }

    fn row(&self, host: &str, root: &str) -> Option<Row> {
        self.rows.get(host)?.get(root).copied()
    }

    /// every repo's colour, by host, then root.
    #[must_use]
    pub fn list(&self) -> Vec<RepoColour> {
        let mut hosts: Vec<&String> = self.rows.keys().collect();
        hosts.sort();
        hosts
            .into_iter()
            .flat_map(|host| {
                self.rows[host]
                    .iter()
                    .map(move |(root, row)| wire(host, root, *row))
            })
            .collect()
    }

    /// the colour a new repo on `host` gets: of the colours the host's repos
    /// wear least, the one its hash names when it is among them, else the
    /// lowest slot.
    fn pick(&self, host: &str, root: &str) -> u8 {
        let mut wearing = [0_usize; NAMES.len()];
        for row in self.rows.get(host).into_iter().flat_map(BTreeMap::values) {
            if let Some(count) = wearing.get_mut(usize::from(row.shown())) {
                *count += 1;
            }
        }
        let least = wearing.iter().copied().min().unwrap_or(0);
        let hash = hashed(host, root);
        if wearing.get(usize::from(hash)) == Some(&least) {
            return hash;
        }
        wearing
            .iter()
            .position(|count| *count == least)
            .and_then(|at| u8::try_from(at).ok())
            .unwrap_or(hash)
    }

    /// a host read or a session change showed the repo: its row's last use
    /// moves to now, and is written, at most once a day, so a busy repo costs
    /// one write a day and a restart's trim, which runs before any host read,
    /// finds it recent.
    pub fn seen(&mut self, host: &str, root: &str, now: i64) -> Option<Write> {
        let row = self.rows.get_mut(host)?.get_mut(root)?;
        if now - row.at < SEEN_EVERY_MS {
            return None;
        }
        row.at = now;
        let row = *row;
        Some(Write::Put {
            host: host.to_owned(),
            root: root.to_owned(),
            value: stored(row),
            at: now,
        })
    }

    /// gives `root` on `host` a colour if it has none and the fleet gives
    /// them: the repo's colour, and the writes for the store. `in_use`
    /// lists the repos a session in the fleet works in, which the cap never
    /// takes; it is called only when the cap is reached. a repo whose
    /// subject the table cannot hold gets none, and shows its hash colour.
    pub fn assign(
        &mut self,
        host: &str,
        root: &str,
        now: i64,
        in_use: impl FnOnce() -> InUse,
    ) -> Option<(RepoColour, Vec<Write>)> {
        if !self.assigning || self.has(host, root) || !keepable(host, root) {
            return None;
        }
        let row = Row {
            auto: self.pick(host, root),
            chosen: None,
            at: now,
        };
        Some(self.put(host, root, row, in_use))
    }

    /// sets the colour a person chose for `root` on `host`, or none for
    /// automatic, which shows the colour the repo was given again. a repo
    /// with no row is given one first, the way a session of it would. the
    /// repo's colour, the writes for the store, and whether it moved. a
    /// choice that moves nothing still writes the row: it may be the retry
    /// of one whose write was dropped, and its answer must mean kept.
    pub fn choose(
        &mut self,
        host: &str,
        root: &str,
        chosen: Option<u8>,
        now: i64,
        in_use: impl FnOnce() -> InUse,
    ) -> (RepoColour, Vec<Write>, bool) {
        let (auto, moved) = match self.row(host, root) {
            Some(row) => (row.auto, row.chosen != chosen),
            None => (self.pick(host, root), true),
        };
        let row = Row {
            auto,
            chosen,
            at: now,
        };
        let (colour, writes) = self.put(host, root, row, in_use);
        (colour, writes, moved)
    }

    fn put(
        &mut self,
        host: &str,
        root: &str,
        row: Row,
        in_use: impl FnOnce() -> InUse,
    ) -> (RepoColour, Vec<Write>) {
        self.insert(host, root, row);
        let mut writes = vec![Write::Put {
            host: host.to_owned(),
            root: root.to_owned(),
            value: stored(row),
            at: row.at,
        }];
        if self.len > MAX_COLOURS {
            let in_use = in_use();
            for (gone_host, gone_root) in self.evictable(host, root, &in_use) {
                self.remove(&gone_host, &gone_root);
                writes.push(Write::Remove {
                    host: gone_host,
                    root: gone_root,
                });
            }
        }
        (wire(host, root, row), writes)
    }

    /// the rows the cap takes, in one pass: as many as the map is over, of
    /// those no session uses, automatic before chosen, the longest unchanged
    /// first, never the one just written. with every other row in use none
    /// go, and the map holds no more rows than the fleet holds repos.
    fn evictable(&self, host: &str, root: &str, in_use: &InUse) -> Vec<(String, String)> {
        let over = self.len.saturating_sub(MAX_COLOURS);
        let mut idle: Vec<(&String, &String, &Row)> = self
            .rows
            .iter()
            .flat_map(|(h, rows)| rows.iter().map(move |(r, row)| (h, r, row)))
            .filter(|(h, r, _)| (h.as_str(), r.as_str()) != (host, root))
            .filter(|(h, r, _)| {
                !in_use
                    .get(h.as_str())
                    .is_some_and(|roots| roots.contains(r.as_str()))
            })
            .collect();
        idle.sort_by_key(|(h, r, row)| (row.chosen.is_some(), row.at, *h, *r));
        idle.into_iter()
            .take(over)
            .map(|(h, r, _)| (h.clone(), r.clone()))
            .collect()
    }

    fn insert(&mut self, host: &str, root: &str, row: Row) {
        let rows = self.rows.entry(host.to_owned()).or_default();
        if rows.insert(root.to_owned(), row).is_none() {
            self.len += 1;
        }
    }

    fn remove(&mut self, host: &str, root: &str) {
        let Some(rows) = self.rows.get_mut(host) else {
            return;
        };
        if rows.remove(root).is_some() {
            self.len -= 1;
        }
        if rows.is_empty() {
            self.rows.remove(host);
        }
    }
}

fn wire(host: &str, root: &str, row: Row) -> RepoColour {
    RepoColour {
        host: host.to_owned(),
        root: root.to_owned(),
        auto: name(row.auto).to_owned(),
        chosen: row.chosen.map(|slot| name(slot).to_owned()),
    }
}

fn stored(row: Row) -> String {
    serde_json::to_string(&Value {
        auto: name(row.auto).to_owned(),
        chosen: row.chosen.map(|slot| name(slot).to_owned()),
    })
    .unwrap_or_default()
}

/// every row of the scope, as `(subject, value, updated_at)`.
///
/// # Errors
/// sqlite's.
pub fn load(connection: &Connection) -> rusqlite::Result<Vec<Kept>> {
    let mut statement =
        connection.prepare("SELECT subject, value, updated_at FROM prefs WHERE scope = ?1")?;
    statement
        .query_map([SCOPE], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect()
}

/// carries one write out.
///
/// # Errors
/// sqlite's.
pub fn save(connection: &Connection, write: &Write) -> rusqlite::Result<()> {
    match write {
        Write::Put {
            host,
            root,
            value,
            at,
        } => connection.execute(
            "INSERT INTO prefs (scope, subject, value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (scope, subject) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![SCOPE, format!("{host}:{root}"), value, at],
        )?,
        Write::Remove { host, root } => remove(connection, &format!("{host}:{root}"))?,
    };
    Ok(())
}

/// deletes one row by its subject.
///
/// # Errors
/// sqlite's.
pub fn remove(connection: &Connection, subject: &str) -> rusqlite::Result<usize> {
    connection.execute(
        "DELETE FROM prefs WHERE scope = ?1 AND subject = ?2",
        params![SCOPE, subject],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "desk";

    fn nobody() -> InUse {
        InUse::new()
    }

    fn shown(colour: &RepoColour) -> &str {
        colour.chosen.as_deref().unwrap_or(&colour.auto)
    }

    /// a root on `HOST` whose hash names `slot`, the `n`th such one.
    fn root_hashing_to(slot: u8, n: usize) -> String {
        (0..)
            .map(|i| format!("/work/r{i}"))
            .filter(|root| hashed(HOST, root) == slot)
            .nth(n)
            .unwrap()
    }

    fn assign(colours: &mut Colours, root: &str) -> RepoColour {
        colours.assign(HOST, root, 1, nobody).unwrap().0
    }

    #[test]
    fn fnv1a_agrees_with_the_apps() {
        // the same strings and values are pinned in app/src/ui/window/repo.test.ts
        for (text, hash) in [
            ("", 0x811c_9dc5),
            ("a", 0xe40c_292c),
            ("desk:/work/api", 0xdfdf_94d9),
            ("desk:/", 0xc039_e7ab),
            ("laptop:/home/dev/src/notes", 0x8454_d56a),
            ("desk:/work/café", 0x8913_ec0a),
            ("desk:/work/日本語", 0xc9de_67e4),
            ("desk:/work/🦀", 0x5403_3c1d),
        ] {
            assert_eq!(fnv1a(text), hash, "{text}");
        }
    }

    #[test]
    fn the_names_are_the_apps_ten_in_its_order() {
        assert_eq!(
            NAMES,
            [
                "green", "violet", "rose", "cobalt", "blue", "teal", "sunset", "plum", "magenta",
                "slate"
            ]
        );
        assert_eq!(slot("cobalt"), Some(3));
        assert_eq!(
            slot("coral"),
            None,
            "assistant palettes are not repo colours"
        );
    }

    #[test]
    fn a_first_repo_takes_its_hash_colour() {
        let mut colours = Colours::assigning();
        let colour = assign(&mut colours, "/work/api");
        assert_eq!(colour.auto, name(hashed(HOST, "/work/api")));
        assert_eq!(colour.chosen, None);
    }

    #[test]
    fn a_repo_whose_hash_colour_is_worn_takes_the_lowest_free_slot() {
        let mut colours = Colours::assigning();
        let first = root_hashing_to(4, 0);
        let second = root_hashing_to(4, 1);
        assert_eq!(assign(&mut colours, &first).auto, "blue");
        assert_eq!(
            assign(&mut colours, &second).auto,
            "green",
            "slot 0 is the lowest free"
        );
        let third = root_hashing_to(0, 2);
        assert_eq!(
            assign(&mut colours, &third).auto,
            "violet",
            "green is worn now too"
        );
    }

    #[test]
    fn ten_repos_on_a_host_wear_ten_colours_and_the_eleventh_shares_its_hash_colour() {
        let mut colours = Colours::assigning();
        let mut worn = std::collections::BTreeSet::new();
        // ten roots that all hash to the same slot: the worst case for a hash
        for n in 0..10 {
            let colour = assign(&mut colours, &root_hashing_to(7, n));
            assert!(worn.insert(colour.auto.clone()), "{} twice", colour.auto);
        }
        assert_eq!(worn.len(), 10);
        // every colour is worn once: all tie, and the hash wins the tie
        let eleventh = root_hashing_to(2, 0);
        assert_eq!(assign(&mut colours, &eleventh).auto, "rose");
        // now rose is worn twice; the twelfth, hashing to rose, takes the lowest of the rest
        let twelfth = root_hashing_to(2, 1);
        assert_eq!(assign(&mut colours, &twelfth).auto, "green");
    }

    #[test]
    fn hosts_count_apart() {
        let mut colours = Colours::assigning();
        let root = root_hashing_to(5, 0);
        assign(&mut colours, &root);
        let other = colours.assign("laptop", &root, 1, nobody).unwrap().0;
        assert_eq!(
            other.auto,
            name(hashed("laptop", &root)),
            "another host's repos do not count"
        );
    }

    #[test]
    fn a_chosen_colour_counts_as_worn_and_automatic_restores_the_given_one() {
        let mut colours = Colours::assigning();
        let api = root_hashing_to(3, 0);
        assert_eq!(assign(&mut colours, &api).auto, "cobalt");
        let (chosen, writes, moved) = colours.choose(HOST, &api, slot("sunset"), 2, nobody);
        assert!(moved);
        assert_eq!(shown(&chosen), "sunset");
        assert_eq!(writes.len(), 1);
        // cobalt is free again, sunset is worn
        let next = root_hashing_to(6, 0);
        assert_eq!(
            assign(&mut colours, &next).auto,
            "green",
            "sunset is worn by the choice"
        );
        let cobalt = root_hashing_to(3, 1);
        assert_eq!(
            assign(&mut colours, &cobalt).auto,
            "cobalt",
            "the auto colour under a choice is free"
        );
        // automatic shows what api was given, even though another repo wears it now
        let (back, ..) = colours.choose(HOST, &api, None, 3, nobody);
        assert_eq!(
            (back.auto.as_str(), back.chosen.as_deref()),
            ("cobalt", None)
        );
        // the same choice again changes nothing
        let (_, writes, moved) = colours.choose(HOST, &api, None, 4, nobody);
        assert!(!moved);
        assert_eq!(
            writes.len(),
            1,
            "it still writes the row, for a retry after a dropped write"
        );
    }

    #[test]
    fn choosing_for_a_repo_with_no_colour_gives_it_one_first() {
        let mut colours = Colours::default();
        let (colour, writes, _) = colours.choose(HOST, "/work/new", slot("teal"), 1, nobody);
        assert_eq!(colour.auto, name(hashed(HOST, "/work/new")));
        assert_eq!(colour.chosen.as_deref(), Some("teal"));
        assert_eq!(writes.len(), 1);
    }

    #[test]
    fn colours_that_are_off_give_nothing_by_themselves() {
        let mut colours = Colours::default();
        assert!(colours.assign(HOST, "/work/api", 1, nobody).is_none());
        assert_eq!(colours.len(), 0);
    }

    #[test]
    fn rows_read_back_leniently() {
        let api = root_hashing_to(1, 0);
        let (colours, dropped) = Colours::restore(vec![
            (
                format!("{HOST}:{api}"),
                r#"{"auto":"indigo","chosen":null}"#.into(),
                5,
            ),
            (
                format!("{HOST}:/work/b"),
                r#"{"auto":"teal","chosen":"ultraviolet","since":3}"#.into(),
                5,
            ),
            (format!("{HOST}:/work/c"), r#"{"auto":"plum"}"#.into(), 5),
            (format!("{HOST}:/work/bad"), "not json".into(), 5),
            (
                "no-colon".into(),
                r#"{"auto":"teal","chosen":null}"#.into(),
                5,
            ),
            (
                format!("{HOST}:/"),
                r#"{"auto":"slate","chosen":"rose"}"#.into(),
                5,
            ),
        ]);
        assert!(dropped.is_empty());
        assert!(colours.is_assigning());
        let list = colours.list();
        let by_root = |root: &str| list.iter().find(|c| c.root == root).unwrap();
        assert_eq!(list.len(), 4, "the two bad rows are left out");
        assert_eq!(
            by_root(&api).auto,
            "violet",
            "an unknown name reads as the hash colour"
        );
        assert_eq!(
            by_root("/work/b").chosen.as_deref(),
            Some(name(hashed(HOST, "/work/b"))),
            "an unknown choice shows the hash colour too"
        );
        assert_eq!(by_root("/work/c").chosen, None);
        assert_eq!(
            shown(by_root("/")),
            "rose",
            "the root folder is a repo like any other"
        );
    }

    #[test]
    fn a_restart_over_the_cap_trims_the_repos_used_longest_ago_not_the_oldest_given() {
        let mut colours = Colours::assigning();
        // the busy repo was given its colour first, long ago
        colours.assign(HOST, "/work/busy", 0, nobody);
        // ...and a host read showed it since
        let mut writes: Vec<Write> = colours
            .seen(HOST, "/work/busy", 10 * SEEN_EVERY_MS)
            .into_iter()
            .collect();
        assert_eq!(writes.len(), 1);
        // the table holds every row the map held, as when a remove was dropped
        let kept: Vec<Kept> = std::mem::take(&mut writes)
            .into_iter()
            .chain((0..MAX_COLOURS).map(|n| Write::Put {
                host: HOST.into(),
                root: format!("/work/{n}"),
                value: r#"{"auto":"green","chosen":null}"#.into(),
                at: 10 + i64::try_from(n).unwrap(),
            }))
            .map(|write| match write {
                Write::Put {
                    host,
                    root,
                    value,
                    at,
                } => (format!("{host}:{root}"), value, at),
                Write::Remove { .. } => unreachable!(),
            })
            .collect();
        let (read, dropped) = Colours::restore(kept);
        assert!(
            read.has(HOST, "/work/busy"),
            "the busy repo keeps its colour"
        );
        assert_eq!(
            dropped,
            vec![format!("{HOST}:/work/0")],
            "the one used longest ago goes"
        );
    }

    #[test]
    fn a_store_past_the_cap_keeps_the_newest_rows() {
        let kept = (0..=MAX_COLOURS)
            .map(|n| {
                (
                    format!("{HOST}:/work/{n}"),
                    r#"{"auto":"green","chosen":null}"#.to_owned(),
                    i64::try_from(n).unwrap(),
                )
            })
            .collect();
        let (colours, dropped) = Colours::restore(kept);
        assert_eq!(colours.len(), MAX_COLOURS);
        assert_eq!(dropped, vec![format!("{HOST}:/work/0")]);
    }

    #[test]
    fn the_cap_takes_a_repo_no_session_uses_automatic_before_chosen() {
        let mut colours = Colours::assigning();
        for n in 0..MAX_COLOURS {
            let at = i64::try_from(n).unwrap();
            colours.assign(HOST, &format!("/work/{n}"), at, nobody);
        }
        // the oldest is in use, the next oldest was chosen: the third oldest goes
        colours.choose(HOST, "/work/1", slot("rose"), 1, nobody);
        let in_use = || InUse::from([(HOST.to_owned(), HashSet::from(["/work/0".to_owned()]))]);
        let (_, writes) = colours.assign(HOST, "/work/new", 9_999, in_use).unwrap();
        assert_eq!(colours.len(), MAX_COLOURS);
        assert_eq!(
            writes.last(),
            Some(&Write::Remove {
                host: HOST.into(),
                root: "/work/2".into()
            })
        );
        assert!(colours.has(HOST, "/work/0") && colours.has(HOST, "/work/1"));
    }

    #[test]
    fn the_cap_never_takes_a_repo_a_session_uses() {
        let mut colours = Colours::assigning();
        for n in 0..MAX_COLOURS {
            colours.assign(HOST, &format!("/work/{n}"), 1, nobody);
        }
        let every = || {
            InUse::from([(
                HOST.to_owned(),
                (0..MAX_COLOURS).map(|n| format!("/work/{n}")).collect(),
            )])
        };
        let (_, writes) = colours.assign(HOST, "/work/new", 2, every).unwrap();
        assert_eq!(writes.len(), 1, "nothing goes");
        assert_eq!(colours.len(), MAX_COLOURS + 1);
    }

    #[test]
    fn a_repo_whose_subject_the_table_cannot_hold_gets_no_row() {
        let mut colours = Colours::assigning();
        let long = format!("/{}", "d".repeat(SUBJECT_MAX));
        assert!(colours.assign(HOST, &long, 1, nobody).is_none());
        assert!(!keepable(HOST, &long));
        assert!(keepable(
            HOST,
            &format!("/{}", "d".repeat(SUBJECT_MAX - HOST.len() - 2))
        ));
    }

    #[test]
    fn writes_round_trip_through_the_store() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let mut colours = Colours::assigning();
        let (_, mut writes) = colours.assign(HOST, "/work/api", 7, nobody).unwrap();
        writes.extend(colours.choose(HOST, "/work/api", slot("plum"), 8, nobody).1);
        let day = SEEN_EVERY_MS;
        assert!(
            colours.seen(HOST, "/work/api", 8 + day - 1).is_none(),
            "not again within the day"
        );
        writes.extend(colours.seen(HOST, "/work/api", 8 + day));
        writes.extend(colours.assign(HOST, "/work/gone", 9, nobody).unwrap().1);
        writes.push(Write::Remove {
            host: HOST.into(),
            root: "/work/gone".into(),
        });
        let kept = carried_out(&store, writes);
        let (read, _) = Colours::restore(kept);
        assert_eq!(read.list().len(), 1);
        assert_eq!(read.list()[0].chosen.as_deref(), Some("plum"));
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// carries the writes out on the store's thread and reads the scope back.
    fn carried_out(store: &crate::store::Store, writes: Vec<Write>) -> Vec<Kept> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(store.call(move |connection| {
                for write in &writes {
                    save(connection, write)?;
                }
                load(connection)
            }))
            .unwrap()
    }
}
