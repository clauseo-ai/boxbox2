//! the media rows in `boxbox.db` (migration 7): `media`, `media_refs`,
//! `media_sidecars`. every function here runs on the store writer, inside
//! the media task's jobs; the route never touches sqlite itself.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use super::evict::{self, Candidate};
use super::{MediaObject, Origin};

/// media under this age never go (`agents.md`, media, eviction).
pub const FLOOR_MS: i64 = 24 * 60 * 60 * 1000;
/// tombstones kept; past this the oldest are dropped.
pub const TOMBSTONES: i64 = 100_000;
/// a serve moves `last_used` only when it is older than this, so audio
/// scrubbing does not write a row per range request.
pub const TOUCH_EVERY_MS: i64 = 60_000;

/// what an id names, for the route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    Ready(MediaObject),
    Evicted,
    Unknown,
}

/// a file about to take its address, and what was declared about it.
#[derive(Debug)]
pub struct Arrival<'a> {
    pub object: &'a MediaObject,
    pub origin: Origin,
    pub tmp: &'a Path,
    pub address: &'a Path,
    /// the store's directory, for the victims' addresses.
    pub root: &'a Path,
    /// an upload is pinned until its send settles or 10 minutes pass.
    pub pinned_until: Option<i64>,
    pub now: i64,
}

/// how a commit ended.
#[derive(Debug)]
pub enum Committed {
    /// the bytes were new (or back from a tombstone): written, `added` bytes
    /// more in the store, `evicted` files dropped to make room.
    Stored {
        object: MediaObject,
        added: u64,
        evicted: Vec<Candidate>,
    },
    /// the store already held these bytes; the new file was dropped.
    Duplicate { object: MediaObject },
    /// no room, even with every file that may go gone. nothing was evicted.
    Full,
}

fn size_of(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn sql_size(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn object_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaObject> {
    Ok(MediaObject {
        id: row.get("id")?,
        mime: row.get("mime")?,
        size: size_of(row.get("size")?),
        filename: row.get("filename")?,
        duration_ms: row
            .get::<_, Option<i64>>("duration_ms")?
            .and_then(|v| u64::try_from(v).ok()),
        waveform: row.get("waveform")?,
        width: row
            .get::<_, Option<i64>>("width")?
            .and_then(|v| u32::try_from(v).ok()),
        height: row
            .get::<_, Option<i64>>("height")?
            .and_then(|v| u32::try_from(v).ok()),
    })
}

const COLUMNS: &str = "id, mime, size, filename, duration_ms, waveform, width, height";

/// the bytes the live files take, for the media task's count at start.
pub fn total(connection: &Connection) -> rusqlite::Result<u64> {
    let sum: i64 = connection.query_row(
        "SELECT coalesce(sum(size), 0) FROM media WHERE evicted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    Ok(size_of(sum))
}

/// every live id, for the startup check against the files.
pub fn live(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare("SELECT id FROM media WHERE evicted_at IS NULL")?;
    statement.query_map([], |row| row.get(0))?.collect()
}

/// rows whose file is gone (removed by hand, or an eviction whose rows did
/// not commit) become tombstones.
pub fn tombstone(connection: &mut Connection, ids: &[String], now: i64) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    {
        let mut statement = transaction
            .prepare("UPDATE media SET evicted_at = ?2 WHERE id = ?1 AND evicted_at IS NULL")?;
        for id in ids {
            statement.execute(params![id, now])?;
        }
    }
    transaction.commit()
}

/// the row for a serve, moving its `last_used`.
pub fn lookup(connection: &Connection, id: &str, now: i64) -> rusqlite::Result<Lookup> {
    let found = connection
        .query_row(
            &format!("SELECT {COLUMNS}, evicted_at FROM media WHERE id = ?1"),
            [id],
            |row| Ok((object_from(row)?, row.get::<_, Option<i64>>("evicted_at")?)),
        )
        .optional()?;
    Ok(match found {
        None => Lookup::Unknown,
        Some((_, Some(_))) => Lookup::Evicted,
        Some((object, None)) => {
            connection.execute(
                "UPDATE media SET last_used = ?2 WHERE id = ?1 AND last_used < ?2 - ?3",
                params![id, now, TOUCH_EVERY_MS],
            )?;
            Lookup::Ready(object)
        }
    })
}

/// takes a file to its address and its row into the index, evicting first
/// when it would pass `cap`. the order is the safe one: the new file is
/// placed, the rows are written (the new one, the victims' tombstones) and
/// committed, and only then are the victims' files removed. a transaction
/// that fails removes the placed file and leaves every victim readable; a
/// crash after the commit leaves orphan files, which the startup check
/// removes.
pub fn commit(
    connection: &mut Connection,
    arrival: &Arrival<'_>,
    total: u64,
    cap: u64,
) -> rusqlite::Result<Result<Committed, std::io::Error>> {
    let transaction = connection.transaction()?;
    let object = arrival.object;
    let existing: Option<(Option<i64>, i64)> = transaction
        .query_row(
            "SELECT evicted_at, size FROM media WHERE id = ?1",
            [&object.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    // a live row: its bytes are already counted in `total`
    let counted = match existing {
        Some((None, size)) => Some(size_of(size)),
        _ => None,
    };
    if counted.is_some() && arrival.address.exists() {
        let kept = refresh(&transaction, arrival)?;
        transaction.commit()?;
        return Ok(Ok(Committed::Duplicate { object: kept }));
    }
    // a live row whose file went missing: its bytes leave the count and come back with the file
    let total = total.saturating_sub(counted.unwrap_or(0));
    let Some(victims) = evict::plan(total, object.size, cap, candidates(&transaction, arrival)?)
    else {
        return Ok(Ok(Committed::Full));
    };
    if let Err(e) = place(arrival.tmp, arrival.address) {
        return Ok(Err(e));
    }
    let written = (|| {
        for victim in &victims {
            transaction.execute(
                "UPDATE media SET evicted_at = ?2 WHERE id = ?1",
                params![victim.id, arrival.now],
            )?;
        }
        upsert(&transaction, arrival)?;
        drop_old_tombstones(&transaction)?;
        let kept = transaction.query_row(
            &format!("SELECT {COLUMNS} FROM media WHERE id = ?1"),
            [&object.id],
            object_from,
        )?;
        transaction.commit()?;
        Ok(kept)
    })();
    let kept = match written {
        Ok(kept) => kept,
        Err(error) => {
            // nothing was committed: the placed file goes, the victims stay as they were
            if let Err(removal) = std::fs::remove_file(arrival.address) {
                tracing::warn!(id = %object.id, error = %removal, "a media file whose row did not commit could not be removed; the startup check removes it");
            }
            return Err(error);
        }
    };
    remove_victims(arrival.root, &victims);
    Ok(Ok(Committed::Stored {
        object: kept,
        added: object.size.saturating_sub(counted.unwrap_or(0)),
        evicted: victims,
    }))
}

/// the evicted files, after their tombstones committed. a file that cannot
/// be removed is an orphan: its row says evicted (410) and the count no
/// longer holds it, so the disk is over the cap by it until the startup
/// check removes it. logged, never a reason to undo the commit.
fn remove_victims(root: &Path, victims: &[Candidate]) {
    for victim in victims {
        let Some(path) = super::address(root, &victim.id) else {
            continue;
        };
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(id = %victim.id, %error, "an evicted media file could not be removed; the startup check removes it");
            }
        }
    }
}

/// the same bytes, kept already: the first upload's name stands, what it
/// lacked the new one may add, and a new pin only lengthens the old one.
fn refresh(connection: &Connection, arrival: &Arrival<'_>) -> rusqlite::Result<MediaObject> {
    let object = arrival.object;
    connection.execute(
        "UPDATE media SET
             mime = CASE WHEN mime = 'application/octet-stream' THEN ?9 ELSE mime END,
             filename = coalesce(filename, ?2),
             duration_ms = coalesce(duration_ms, ?3),
             waveform = coalesce(waveform, ?4),
             width = coalesce(width, ?5),
             height = coalesce(height, ?6),
             last_used = ?7,
             pinned_until = CASE WHEN ?8 IS NULL THEN pinned_until
                                 ELSE max(coalesce(pinned_until, 0), ?8) END
         WHERE id = ?1",
        params![
            object.id,
            object.filename,
            object.duration_ms.map(sql_size),
            object.waveform,
            object.width,
            object.height,
            arrival.now,
            arrival.pinned_until,
            object.mime,
        ],
    )?;
    connection.query_row(
        &format!("SELECT {COLUMNS} FROM media WHERE id = ?1"),
        [&object.id],
        object_from,
    )
}

/// the files eviction may take, least recently used first: live, not the
/// arriving id, past their pin and at least a day old.
fn candidates(connection: &Connection, arrival: &Arrival<'_>) -> rusqlite::Result<Vec<Candidate>> {
    let mut statement = connection.prepare(
        "SELECT id, size FROM media
         WHERE evicted_at IS NULL
           AND id != ?1
           AND (pinned_until IS NULL OR pinned_until <= ?2)
           AND created <= ?2 - ?3
         ORDER BY last_used ASC, created ASC",
    )?;
    statement
        .query_map(params![arrival.object.id, arrival.now, FLOOR_MS], |row| {
            Ok(Candidate {
                id: row.get(0)?,
                size: size_of(row.get(1)?),
            })
        })?
        .collect()
}

/// the arriving file's row: new, or a tombstone brought back (its sidecars
/// and refs kept, which a replace would cascade away).
fn upsert(connection: &Connection, arrival: &Arrival<'_>) -> rusqlite::Result<()> {
    let object = arrival.object;
    connection.execute(
        "INSERT INTO media (id, mime, size, filename, duration_ms, waveform, width, height,
                            origin, created, last_used, pinned_until, evicted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, NULL)
         ON CONFLICT (id) DO UPDATE SET
             mime = excluded.mime, size = excluded.size,
             filename = coalesce(media.filename, excluded.filename),
             duration_ms = coalesce(excluded.duration_ms, media.duration_ms),
             waveform = coalesce(excluded.waveform, media.waveform),
             width = coalesce(excluded.width, media.width),
             height = coalesce(excluded.height, media.height),
             origin = excluded.origin, created = excluded.created,
             last_used = excluded.last_used, pinned_until = excluded.pinned_until,
             evicted_at = NULL",
        params![
            object.id,
            object.mime,
            sql_size(object.size),
            object.filename,
            object.duration_ms.map(sql_size),
            object.waveform,
            object.width,
            object.height,
            arrival.origin.as_str(),
            arrival.now,
            arrival.pinned_until,
        ],
    )?;
    Ok(())
}

/// the file to its address, durable before its row says it is there.
fn place(tmp: &Path, address: &Path) -> std::io::Result<()> {
    if let Some(parent) = address.parent() {
        super::create_private_dir(parent)?;
    }
    std::fs::rename(tmp, address)?;
    if let Some(parent) = address.parent() {
        // the rename itself, durable; a filesystem that cannot sync a
        // directory still has the file
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn drop_old_tombstones(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM media WHERE id IN (
             SELECT id FROM media WHERE evicted_at IS NOT NULL
             ORDER BY evicted_at DESC LIMIT -1 OFFSET ?1)",
        [TOMBSTONES],
    )?;
    Ok(())
}

#[allow(
    dead_code,
    reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
)]
/// pins a live id until at least `until` (ms): a pin only ever lengthens,
/// so two sends of the same bytes never cut each other's short. answers
/// whether a live row was there.
pub fn pin(connection: &Connection, id: &str, until: i64) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        "UPDATE media SET pinned_until = max(coalesce(pinned_until, 0), ?2)
         WHERE id = ?1 AND evicted_at IS NULL",
        params![id, until],
    )?;
    Ok(changed > 0)
}

#[allow(
    dead_code,
    reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
)]
/// lets a pin go early, when its send settled, but only the pin this holder
/// set (`until`, the value it pinned with): a later holder that lengthened
/// the pin keeps it. answers whether the pin went.
pub fn release(connection: &Connection, id: &str, until: i64) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        "UPDATE media SET pinned_until = NULL WHERE id = ?1 AND pinned_until = ?2",
        params![id, until],
    )?;
    Ok(changed > 0)
}

#[allow(
    dead_code,
    reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
)]
/// records what holds a media id. answers false when the id is unknown.
pub fn add_ref(
    connection: &Connection,
    id: &str,
    agent: &str,
    thread: &str,
    message: &str,
) -> rusqlite::Result<bool> {
    if !exists(connection, id)? {
        return Ok(false);
    }
    connection.execute(
        "INSERT OR IGNORE INTO media_refs (media, agent, thread, message) VALUES (?1, ?2, ?3, ?4)",
        params![id, agent, thread, message],
    )?;
    Ok(true)
}

#[allow(
    dead_code,
    reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
)]
fn exists(connection: &Connection, id: &str) -> rusqlite::Result<bool> {
    connection
        .query_row("SELECT 1 FROM media WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
}

#[allow(
    dead_code,
    reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
)]
/// a device's transcript of its voice note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sidecar {
    pub media: String,
    pub thread: String,
    pub transcript: String,
    pub lang: Option<String>,
    pub device: Option<String>,
    pub created: i64,
}

#[allow(
    dead_code,
    reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
)]
/// how a sidecar write ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarKept {
    Kept,
    /// the index holds no such media id.
    Unknown,
    /// the id is not audio: a transcript belongs to a voice note.
    NotAudio,
}

/// writes (or replaces) the transcript for an audio media id in a thread.
pub fn put_sidecar(connection: &Connection, sidecar: &Sidecar) -> rusqlite::Result<SidecarKept> {
    let mime: Option<String> = connection
        .query_row(
            "SELECT mime FROM media WHERE id = ?1",
            [&sidecar.media],
            |row| row.get(0),
        )
        .optional()?;
    match mime {
        None => return Ok(SidecarKept::Unknown),
        Some(mime) if !mime.starts_with("audio/") => return Ok(SidecarKept::NotAudio),
        Some(_) => {}
    }
    connection.execute(
        "INSERT INTO media_sidecars (media, thread, transcript, lang, device, created)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (media, thread) DO UPDATE SET
             transcript = excluded.transcript, lang = excluded.lang,
             device = excluded.device, created = excluded.created",
        params![
            sidecar.media,
            sidecar.thread,
            sidecar.transcript,
            sidecar.lang,
            sidecar.device,
            sidecar.created,
        ],
    )?;
    Ok(SidecarKept::Kept)
}

#[allow(
    dead_code,
    reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
)]
/// the transcripts for these media ids in `thread`.
pub fn sidecars(
    connection: &Connection,
    ids: &[String],
    thread: &str,
) -> rusqlite::Result<Vec<Sidecar>> {
    let mut statement = connection.prepare(
        "SELECT media, thread, transcript, lang, device, created
         FROM media_sidecars WHERE media = ?1 AND thread = ?2",
    )?;
    let mut found = Vec::new();
    for id in ids {
        let rows = statement.query_map(params![id, thread], |row| {
            Ok(Sidecar {
                media: row.get(0)?,
                thread: row.get(1)?,
                transcript: row.get(2)?,
                lang: row.get(3)?,
                device: row.get(4)?,
                created: row.get(5)?,
            })
        })?;
        for row in rows {
            found.push(row?);
        }
    }
    Ok(found)
}
