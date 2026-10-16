//! reading a host afresh: its sessions, statuses and asks, each stamped
//! with the seq it reflects (`x-cmx2-seq`, cmx2-asks a2).
//!
//! used on a cold connect (the server has nothing for the host) and after
//! the daemon answers a resume with `stream.reset`. the event stream then
//! resumes from the oldest read's seq, and the fleet drops what each read
//! already held, so nothing is missed and nothing applies twice. no merge
//! heuristics: a read is taken whole, and every later event is exact.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use tokio::time::timeout;
use tracing::info;

use super::{get, plain};
use crate::config::HostConfig;
use crate::journal::Cursor;

/// one host read afresh, each read stamped with the seq it reflects
/// (cmx2-asks a2). the cmx2 source turns it into the agent's snapshot
/// (`source/cmx2/translate.rs`).
#[derive(Debug)]
pub struct HostRead {
    pub host: String,
    pub epoch: String,
    pub sessions: Stamped<Vec<Box<RawValue>>>,
    /// the `GET /session/status?parked=true` map: busy, retrying and parked
    /// sessions, each with its status.
    pub statuses: Stamped<Vec<(String, Box<RawValue>)>>,
    pub permissions: Stamped<Vec<Box<RawValue>>>,
    pub questions: Stamped<Vec<Box<RawValue>>>,
}

#[derive(Debug)]
pub struct Stamped<T> {
    pub seq: u64,
    pub data: T,
}

impl HostRead {
    /// the cursor the event stream resumes from: the oldest read, so no
    /// event any read missed is skipped (the floors drop what they had).
    #[must_use]
    pub fn resume_seq(&self) -> u64 {
        self.sessions
            .seq
            .min(self.statuses.seq)
            .min(self.permissions.seq)
            .min(self.questions.seq)
    }
}

/// 300 sessions of a few kilobytes each fit with room; a read past this is
/// refused rather than held (every buffer has a byte cap).
const READ_CAP: usize = 8 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// the window order shows at most this many sessions; the read asks for
/// the most recently updated.
const SESSIONS: &str = "/session?limit=300";
const STATUSES: &str = "/session/status?parked=true";
const PERMISSIONS: &str = "/permission";
const QUESTIONS: &str = "/question";

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("{route}: {}", plain(source))]
    Request {
        route: &'static str,
        source: reqwest::Error,
    },
    #[error("{route}: no answer within {}s", READ_TIMEOUT.as_secs())]
    Timeout { route: &'static str },
    #[error("{route} answered {status}")]
    Status {
        route: &'static str,
        status: StatusCode,
    },
    #[error("{route} answered without x-cmx2-seq, so it cannot be lined up with the event stream")]
    NoSeq { route: &'static str },
    #[error("{route} answered more than {} MB", READ_CAP / 1024 / 1024)]
    TooLarge { route: &'static str },
    #[error("{route}: the answer did not decode: {source}")]
    Decode {
        route: &'static str,
        source: serde_json::Error,
    },
    #[error("the daemon's store changed while it was read ({first} then {second}); reading again")]
    EpochMoved { first: String, second: String },
}

/// reads the host whole. every read must come from the same store epoch.
///
/// # Errors
/// a read failed, or the epoch moved between reads.
pub async fn read(client: &reqwest::Client, host: &HostConfig) -> Result<HostRead, ReadError> {
    let started = Instant::now();
    let (sessions, statuses, permissions, questions) = tokio::try_join!(
        stamped::<Vec<Box<RawValue>>>(client, host, SESSIONS),
        stamped::<HashMap<String, Box<RawValue>>>(client, host, STATUSES),
        stamped::<Vec<Box<RawValue>>>(client, host, PERMISSIONS),
        stamped::<Vec<Box<RawValue>>>(client, host, QUESTIONS),
    )?;
    let epoch = sessions.0.epoch.clone();
    for other in [&statuses.0, &permissions.0, &questions.0] {
        if other.epoch != epoch {
            return Err(ReadError::EpochMoved {
                first: epoch,
                second: other.epoch.clone(),
            });
        }
    }
    let read = HostRead {
        host: host.name.clone(),
        epoch,
        sessions: Stamped {
            seq: sessions.0.seq,
            data: sessions.1,
        },
        statuses: Stamped {
            seq: statuses.0.seq,
            data: statuses.1.into_iter().collect(),
        },
        permissions: Stamped {
            seq: permissions.0.seq,
            data: permissions.1,
        },
        questions: Stamped {
            seq: questions.0.seq,
            data: questions.1,
        },
    };
    info!(
        host = %host.name,
        epoch = %read.epoch,
        sessions = read.sessions.data.len(),
        statuses = read.statuses.data.len(),
        permissions = read.permissions.data.len(),
        questions = read.questions.data.len(),
        seqs = %format_args!("{}/{}/{}/{}", read.sessions.seq, read.statuses.seq, read.permissions.seq, read.questions.seq),
        latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "host read"
    );
    Ok(read)
}

async fn stamped<T: DeserializeOwned>(
    client: &reqwest::Client,
    host: &HostConfig,
    route: &'static str,
) -> Result<(Cursor, T), ReadError> {
    let request = async {
        let response = get(client, host, route)
            .send()
            .await
            .map_err(|source| ReadError::Request { route, source })?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(ReadError::Status { route, status });
        }
        let cursor = response
            .headers()
            .get("x-cmx2-seq")
            .and_then(|v| v.to_str().ok())
            .and_then(Cursor::parse)
            .ok_or(ReadError::NoSeq { route })?;
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|source| ReadError::Request { route, source })?;
            if body.len() + chunk.len() > READ_CAP {
                return Err(ReadError::TooLarge { route });
            }
            body.extend_from_slice(&chunk);
        }
        let value =
            serde_json::from_slice(&body).map_err(|source| ReadError::Decode { route, source })?;
        Ok((cursor, value))
    };
    timeout(READ_TIMEOUT, request)
        .await
        .map_err(|_| ReadError::Timeout { route })?
}
