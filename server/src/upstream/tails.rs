//! window tails read from the daemon: the newest messages of a session
//! that got a window, once, so a thread idle since before boxbox started
//! still shows what it last did (the fleet model decides who is read and
//! lines the read up with the event stream by its `x-cmx2-seq`).
//!
//! one task takes the fleet's requests and starts each read under its
//! host's gate, so no host has more than `TAIL_READS_PER_HOST` reads open
//! and a slow host never holds up another. the body is capped and decoded
//! here, off the actor, into the few facts a tail needs.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::StatusCode;
use tokio::sync::{Semaphore, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{Hosts, get, plain};
use crate::config::HostConfig;
use crate::fleet::Upstream;
use crate::fleet::model::{TAIL_ITEMS, TailRequest};
use crate::journal::Cursor;
use crate::source::cmx2::translate;
use crate::source::{SourceEvent, Stamp, TailRead};

/// reads open on one host at once.
pub const TAIL_READS_PER_HOST: usize = 3;
/// reads waiting for their host's gate or running, across hosts. the fleet
/// asks once per session with a window (at most `model::MAX_ORDER`), so
/// this is never reached in practice; past it a request is answered as not
/// read, and the session is read again when its host is.
const IN_FLIGHT: usize = 512;
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// twelve messages are a few kilobytes, unless tools wrote large outputs
/// into them; past this the read is taken again with fewer.
const BODY_CAP: usize = 4 * 1024 * 1024;
/// messages asked for: a tail cannot need more messages than it has
/// items; then, when those were too large, the last few.
const LIMITS: [usize; 2] = [TAIL_ITEMS, 3];

#[derive(Debug, thiserror::Error)]
enum TailError {
    #[error("{host} is not watched any more")]
    UnknownHost { host: String },
    #[error("\"{0}\" is not a session id")]
    NotAnId(String),
    #[error("{}", plain(.0))]
    Request(reqwest::Error),
    #[error("no answer within {}s", READ_TIMEOUT.as_secs())]
    Timeout,
    #[error("the daemon answered {0}")]
    Status(StatusCode),
    #[error("the answer has no x-cmx2-seq, so it cannot be lined up with the event stream")]
    NoSeq,
    #[error("the answer passed {} MB", BODY_CAP / 1024 / 1024)]
    TooLarge,
    #[error("the answer did not decode: {0}")]
    Decode(serde_json::Error),
    #[error("{IN_FLIGHT} reads are already waiting")]
    Busy,
}

/// takes tail requests until `shutdown` fires or the fleet stops asking.
pub async fn run(
    mut requests: mpsc::Receiver<TailRequest>,
    hosts: watch::Receiver<Hosts>,
    client: reqwest::Client,
    fleet: mpsc::Sender<Upstream>,
    shutdown: CancellationToken,
) {
    let mut gates = Gates::default();
    let mut reads = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            Some(_) = reads.join_next(), if !reads.is_empty() => {}
            request = requests.recv() => {
                let Some(request) = request else { break };
                if reads.len() >= IN_FLIGHT {
                    answer_unread(&fleet, &request, &TailError::Busy).await;
                    continue;
                }
                let config = hosts
                    .borrow()
                    .iter()
                    .find(|h| h.config.name == request.host)
                    .map(|h| Arc::clone(&h.config));
                let Some(config) = config else {
                    let error = TailError::UnknownHost { host: request.host.clone() };
                    answer_unread(&fleet, &request, &error).await;
                    continue;
                };
                let gate = gates.of(&request.host);
                let (client, fleet) = (client.clone(), fleet.clone());
                reads.spawn(async move {
                    // the gate is never closed, so a permit always comes
                    let Ok(permit) = gate.acquire_owned().await else { return };
                    let event = match read(&client, &config, &request).await {
                        Ok(read) => SourceEvent::TailRead(Box::new(read)),
                        Err(error) => {
                            warn!(host = %request.host, session = %request.session, %error, "tail read failed");
                            SourceEvent::TailUnread { thread: request.session.clone(), reason: error.to_string() }
                        }
                    };
                    let message = unsequenced(&request.host, event);
                    // the host's next read need not wait on a busy fleet
                    drop(permit);
                    // a stopped fleet means the server is stopping
                    let _ = fleet.send(message).await;
                });
            }
        }
    }
    reads.shutdown().await;
}

/// each host's gate, made the first time the host is read.
#[derive(Debug, Default)]
struct Gates(HashMap<String, Arc<Semaphore>>);

impl Gates {
    fn of(&mut self, host: &str) -> Arc<Semaphore> {
        Arc::clone(
            self.0
                .entry(host.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(TAIL_READS_PER_HOST))),
        )
    }
}

/// a request turned away before any read. it is said to the fleet even when
/// the fleet is busy, so the session is never left waiting on a read that
/// will not come (it is asked again when its host is next read).
async fn answer_unread(fleet: &mpsc::Sender<Upstream>, request: &TailRequest, error: &TailError) {
    warn!(host = %request.host, session = %request.session, %error, "tail read not taken");
    // a stopped fleet means the server is stopping
    let _ = fleet
        .send(unsequenced(
            &request.host,
            SourceEvent::TailUnread {
                thread: request.session.clone(),
                reason: error.to_string(),
            },
        ))
        .await;
}

/// a tail event for the cmx2 agent of `host`: its connection, carrying no
/// event seq of its own.
fn unsequenced(host: &str, event: SourceEvent) -> Upstream {
    let name: Arc<str> = Arc::from(host);
    Upstream::Source {
        connection: Arc::clone(&name),
        agent: name,
        seq: None,
        event,
        raw: None,
    }
}

/// the session's newest messages, the fewer limit when the first is too large.
async fn read(
    client: &reqwest::Client,
    host: &HostConfig,
    request: &TailRequest,
) -> Result<TailRead, TailError> {
    if !is_segment(&request.session) {
        return Err(TailError::NotAnId(request.session.clone()));
    }
    let mut limits = LIMITS.iter().peekable();
    while let Some(&limit) = limits.next() {
        match page(client, host, request, limit).await {
            Err(TailError::TooLarge) if limits.peek().is_some() => {
                info!(host = %request.host, session = %request.session, limit, "tail read too large; reading fewer messages");
            }
            answer => return answer,
        }
    }
    Err(TailError::TooLarge)
}

async fn page(
    client: &reqwest::Client,
    host: &HostConfig,
    request: &TailRequest,
    limit: usize,
) -> Result<TailRead, TailError> {
    let started = Instant::now();
    let route = format!("/session/{}/message?limit={limit}", request.session);
    let answer = async {
        let response = get(client, host, &route)
            .send()
            .await
            .map_err(TailError::Request)?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(TailError::Status(status));
        }
        let cursor = response
            .headers()
            .get("x-cmx2-seq")
            .and_then(|v| v.to_str().ok())
            .and_then(Cursor::parse)
            .ok_or(TailError::NoSeq)?;
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(TailError::Request)?;
            if body.len() + chunk.len() > BODY_CAP {
                return Err(TailError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        #[cfg(feature = "record")]
        crate::fleet::record::tail_body(&request.key, &cursor, &body);
        let stamp = Stamp {
            epoch: cursor.epoch.clone(),
            seq: cursor.seq,
        };
        let read =
            translate::tail(request.session.clone(), stamp, &body).map_err(TailError::Decode)?;
        Ok((cursor, read))
    };
    let (cursor, read) = timeout(READ_TIMEOUT, answer)
        .await
        .map_err(|_| TailError::Timeout)??;
    info!(
        host = %request.host,
        session = %request.session,
        route = "/session/:id/message",
        limit,
        status = 200,
        latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        seq = %cursor,
        messages = read.messages.len(),
        "tail read"
    );
    Ok(read)
}

/// a daemon id as one path segment; anything that could step out of it is
/// refused (the rule `http/transcript.rs` holds the browser's reads to).
fn is_segment(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_host_has_its_own_gate_of_three_reads() {
        let mut gates = Gates::default();
        let desk = gates.of("desk");
        let held: Vec<_> = (0..TAIL_READS_PER_HOST)
            .map(|_| Arc::clone(&desk).try_acquire_owned().unwrap())
            .collect();
        assert!(
            gates.of("desk").try_acquire().is_err(),
            "a fourth read on the same host waits"
        );
        assert!(
            gates.of("laptop").try_acquire().is_ok(),
            "another host is not held up"
        );
        drop(held);
        assert_eq!(gates.of("desk").available_permits(), TAIL_READS_PER_HOST);
    }

    #[test]
    fn the_read_asks_for_a_tails_worth_of_messages_then_a_few() {
        assert_eq!(LIMITS, [TAIL_ITEMS, 3]);
        assert!(LIMITS.windows(2).all(|w| w[0] > w[1]));
    }

    #[test]
    fn only_a_plain_id_becomes_a_path_segment() {
        assert!(is_segment("ses_01JZ-a.b"));
        for bad in ["", ".", "..", "a/b", "a?limit=1", "a%2F", &"x".repeat(129)] {
            assert!(!is_segment(bad), "{bad}");
        }
    }
}
