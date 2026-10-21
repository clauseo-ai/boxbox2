//! a cmx2 thread read as it streams (`docs/protocol.md`, section 11): the
//! daemon's `GET /session/:id/message` answer is split element by element
//! as its bytes arrive, each `{info, parts}` translated to the neutral
//! message and handed on, so at most one message is in memory (32 MiB, the
//! frame cap), never the whole thread.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use futures_util::stream::StreamExt;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::value::RawValue;
use tracing::info;

use super::refs::{MEDIA_REFERENCES, reference};
use crate::journal::Cursor;
use crate::source::cmx2::{Cmx2Source, translate};
use crate::source::{MessageWithParts, Reading, Stamp, Stamped, ThreadFacts, VerbError};
use crate::upstream::{get, plain};

type Body = futures_util::stream::BoxStream<'static, reqwest::Result<bytes::Bytes>>;

/// one message's json, at most.
///
/// boxbox's own composer sends up to 24 MiB of `data:` urls in one message
/// (`http/compose.rs`), so the cap sits above it with room for the rest of
/// the message; a thread holding one is read like any other.
pub const MESSAGE_CAP: usize = 32 * 1024 * 1024;
/// how long a read's body may go without a byte once it began, the event
/// stream's stall rule.
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
/// a session's own facts, at most.
const FACTS_CAP: usize = 1024 * 1024;
/// how long the daemon may take to begin its answer.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// a refusal's body is read this far, at most.
const REFUSAL_BYTES: usize = 4 * 1024;

#[derive(Deserialize)]
struct Element<'a> {
    #[serde(borrow)]
    info: &'a RawValue,
    #[serde(borrow, default)]
    parts: Vec<&'a RawValue>,
}

/// one `{info, parts}` element as the neutral message.
///
/// # Errors
/// it is not an element of the message list.
pub fn element(bytes: &[u8]) -> Result<MessageWithParts, serde_json::Error> {
    let raw: Element<'_> = serde_json::from_slice(bytes)?;
    Ok(MessageWithParts {
        info: translate::message(raw.info)?,
        parts: raw.parts.into_iter().map(translate::part).collect(),
    })
}

impl Cmx2Source {
    /// the session's messages, streamed (`session` is one checked segment).
    ///
    /// # Errors
    /// the daemon could not be reached in time, has no such session, or
    /// refused the read.
    pub async fn read(&self, session: &str) -> Result<Reading, VerbError> {
        let route = format!("/session/{session}/message");
        self.read_route(&route).await
    }

    /// one message of the session, translated (both ids checked segments).
    ///
    /// # Errors
    /// as `read`, or the message is past the cap.
    pub async fn read_one(
        &self,
        session: &str,
        message: &str,
    ) -> Result<Stamped<MessageWithParts>, VerbError> {
        let route = format!("/session/{session}/message/{message}");
        let (upstream, mut body) = self.answer(&route).await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = next(&mut body).await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > MESSAGE_CAP {
                return Err(VerbError::Unreachable {
                    reason: "the daemon's message is past 32 MiB".to_owned(),
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut data = element(&bytes).map_err(|e| VerbError::Unreachable {
            reason: format!("the daemon sent a message boxbox cannot read: {e}"),
        })?;
        if MEDIA_REFERENCES {
            reference(&self.refs, &mut data).await;
        }
        Ok(Stamped { upstream, data })
    }

    /// the session's own facts (`GET /session/:id`), for its directory.
    ///
    /// # Errors
    /// as `read`, or the answer is past 1 MiB or not a session.
    pub async fn read_facts(&self, session: &str) -> Result<ThreadFacts, VerbError> {
        let route = format!("/session/{session}");
        let (_, mut body) = self.answer(&route).await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = next(&mut body).await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > FACTS_CAP {
                return Err(VerbError::Unreachable {
                    reason: "the daemon's session is past 1 MiB".to_owned(),
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        let unreadable = |e: serde_json::Error| VerbError::Unreachable {
            reason: format!("the daemon sent a session boxbox cannot read: {e}"),
        };
        let raw: Box<RawValue> = serde_json::from_slice(&bytes).map_err(unreadable)?;
        translate::thread_from_json(raw).map_err(unreadable)
    }

    async fn read_route(&self, route: &str) -> Result<Reading, VerbError> {
        let (upstream, body) = self.answer(route).await?;
        let media = self.refs.clone();
        let ready: VecDeque<Result<MessageWithParts, VerbError>> = VecDeque::new();
        let state = (body, Splitter::default(), ready, false, media);
        let messages = futures_util::stream::unfold(
            state,
            |(mut body, mut split, mut ready, mut ended, media)| async move {
                loop {
                    if let Some(mut next) = ready.pop_front() {
                        if MEDIA_REFERENCES && let Ok(message) = next.as_mut() {
                            reference(&media, message).await;
                        }
                        return Some((next, (body, split, ready, ended, media)));
                    }
                    if ended {
                        return None;
                    }
                    match next(&mut body).await {
                        Some(Ok(chunk)) => match split.push(&chunk) {
                            Ok(elements) => ready.extend(elements.into_iter().map(|e| {
                                element(&e).map_err(|e| VerbError::Unreachable {
                                    reason: format!(
                                        "the daemon sent a message boxbox cannot read: {e}"
                                    ),
                                })
                            })),
                            Err(e) => {
                                ended = true;
                                ready.push_back(Err(e));
                            }
                        },
                        Some(Err(e)) => {
                            ended = true;
                            ready.push_back(Err(e));
                        }
                        None => {
                            ended = true;
                            if !split.done() {
                                ready.push_back(Err(VerbError::Unreachable {
                                    reason: "the daemon's answer ended early".to_owned(),
                                }));
                            }
                        }
                    }
                }
            },
        )
        .boxed();
        Ok(Reading { upstream, messages })
    }

    /// the daemon's answer to `route`: the event it reflects and its body.
    async fn answer(&self, route: &str) -> Result<(Option<Stamp>, Body), VerbError> {
        let host = self.host().name.clone();
        let started = Instant::now();
        let answer =
            tokio::time::timeout(ANSWER_TIMEOUT, get(&self.client, self.host(), route).send())
                .await
                .map_err(|_| VerbError::Unreachable {
                    reason: format!("no answer within {}s", ANSWER_TIMEOUT.as_secs()),
                })?
                .map_err(|e| VerbError::Unreachable { reason: plain(&e) })?;
        let status = answer.status();
        info!(
            host,
            route = route.split('?').next().unwrap_or(route),
            status = status.as_u16(),
            latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "thread read"
        );
        if status == StatusCode::NOT_FOUND {
            return Err(VerbError::Missing { what: "thread" });
        }
        if !status.is_success() {
            let mut words = answer.text().await.unwrap_or_default();
            words.truncate(words.floor_char_boundary(REFUSAL_BYTES));
            return Err(VerbError::Refused {
                status: status.as_u16(),
                words,
            });
        }
        let upstream = answer
            .headers()
            .get("x-cmx2-seq")
            .and_then(|v| v.to_str().ok())
            .and_then(Cursor::parse)
            .map(|c| Stamp {
                epoch: c.epoch,
                seq: c.seq,
            });
        Ok((upstream, answer.bytes_stream().boxed()))
    }
}

/// where the splitter is in the array.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Stage {
    #[default]
    Before,
    Inside,
    After,
}

/// the body's next chunk, an error when none comes within `IDLE_TIMEOUT`.
async fn next(body: &mut Body) -> Option<Result<bytes::Bytes, VerbError>> {
    match tokio::time::timeout(IDLE_TIMEOUT, body.next()).await {
        Ok(Some(Ok(chunk))) => Some(Ok(chunk)),
        Ok(Some(Err(e))) => Some(Err(VerbError::Unreachable { reason: plain(&e) })),
        Ok(None) => None,
        Err(_) => Some(Err(VerbError::Unreachable {
            reason: format!("the daemon sent nothing for {}s", IDLE_TIMEOUT.as_secs()),
        })),
    }
}

/// splits a json array's elements out of its bytes as they arrive, each at
/// most `MESSAGE_CAP`. it tracks only depth and strings; the elements are
/// parsed whole afterwards.
#[derive(Debug, Default)]
pub struct Splitter {
    stage: Stage,
    depth: usize,
    in_string: bool,
    escaped: bool,
    element: Vec<u8>,
}

impl Splitter {
    /// whether the array's closing bracket arrived.
    #[must_use]
    pub fn done(&self) -> bool {
        self.stage == Stage::After
    }

    /// the elements `chunk` completes.
    ///
    /// # Errors
    /// the bytes are not an array of objects, or an element passes the cap.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, VerbError> {
        let bad = |what: &str| VerbError::Unreachable {
            reason: format!("the daemon's message list {what}"),
        };
        let mut out = Vec::new();
        let mut start: Option<usize> = if self.depth > 0 { Some(0) } else { None };
        for (i, &b) in chunk.iter().enumerate() {
            if self.depth == 0 {
                if b.is_ascii_whitespace() {
                    continue;
                }
                match self.stage {
                    Stage::After => return Err(bad("goes on past its end")),
                    Stage::Before if b != b'[' => return Err(bad("is not a list")),
                    Stage::Before => {
                        self.stage = Stage::Inside;
                        continue;
                    }
                    Stage::Inside => {}
                }
                match b {
                    b',' => continue,
                    b']' => {
                        self.stage = Stage::After;
                        continue;
                    }
                    b'{' => {
                        self.depth = 1;
                        start = Some(i);
                        continue;
                    }
                    _ => return Err(bad("holds something that is not a message")),
                }
            }
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' {
                    self.escaped = true;
                } else if b == b'"' {
                    self.in_string = false;
                }
                continue;
            }
            match b {
                b'"' => self.in_string = true,
                b'{' | b'[' => self.depth += 1,
                b'}' | b']' => {
                    self.depth -= 1;
                    if self.depth == 0 {
                        let from = start.take().unwrap_or(0);
                        let mut whole = std::mem::take(&mut self.element);
                        whole.extend_from_slice(&chunk[from..=i]);
                        if whole.len() > MESSAGE_CAP {
                            return Err(bad("holds a message past 32 MiB"));
                        }
                        out.push(whole);
                    }
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            self.element.extend_from_slice(&chunk[from..]);
            if self.element.len() > MESSAGE_CAP {
                return Err(bad("holds a message past 32 MiB"));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_all(body: &[u8], step: usize) -> Result<(Vec<Vec<u8>>, bool), VerbError> {
        let mut s = Splitter::default();
        let mut out = Vec::new();
        for chunk in body.chunks(step) {
            out.extend(s.push(chunk)?);
        }
        Ok((out, s.done()))
    }

    #[test]
    fn elements_come_out_whole_however_the_bytes_are_cut() {
        let body = br#" [ {"a":"x]}\"{","b":[1,{"c":2}]} , {"d":{}} ] "#;
        for step in 1..body.len() {
            let (out, done) = split_all(body, step).unwrap();
            assert!(done);
            assert_eq!(out.len(), 2, "step {step}");
            assert_eq!(out[0], br#"{"a":"x]}\"{","b":[1,{"c":2}]}"#);
            assert_eq!(out[1], br#"{"d":{}}"#);
        }
    }

    #[test]
    fn an_empty_list_is_done_and_holds_nothing() {
        let (out, done) = split_all(b"[]", 1).unwrap();
        assert!(out.is_empty() && done);
    }

    #[test]
    fn what_is_not_a_list_of_objects_is_refused() {
        assert!(split_all(b"{}", 4).is_err());
        assert!(split_all(b"[1]", 4).is_err());
        assert!(split_all(b"[] []", 4).is_err());
    }

    #[test]
    fn a_message_past_the_cap_is_refused() {
        let mut body = b"[{\"a\":\"".to_vec();
        body.resize(MESSAGE_CAP + 16, b'x');
        assert!(split_all(&body, 64 * 1024).is_err());
    }

    #[test]
    fn a_fixture_reads_message_by_message_as_the_whole_parse_does() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../app/src/ui/thread/fixtures/cmx-deploy.json"
        );
        let bytes = std::fs::read(path).unwrap();
        let whole: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let list = whole
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .or_else(|| whole.as_array())
            .unwrap()
            .clone();
        let body = serde_json::to_vec(&list).unwrap();
        let (out, done) = split_all(&body, 1000).unwrap();
        assert!(done);
        assert_eq!(out.len(), list.len());
        for (e, want) in out.iter().zip(&list) {
            let got: serde_json::Value = serde_json::from_slice(e).unwrap();
            assert_eq!(&got, want);
            element(e).unwrap();
        }
    }
    #[test]
    fn a_message_as_large_as_the_composer_sends_reads() {
        // 24 MiB of data urls, as the composer allows in one message.
        let mut body = br#"[{"info":{"id":"m"},"parts":[{"url":""#.to_vec();
        body.resize(body.len() + 24 * 1024 * 1024, b'A');
        body.extend_from_slice(br#""}]}]"#);
        let (out, done) = split_all(&body, 1024 * 1024).unwrap();
        assert!(done);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), body.len() - 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_body_that_stalls_ends_the_read() {
        let mut body: Body = futures_util::stream::pending().boxed();
        let got = next(&mut body).await;
        assert!(
            matches!(got, Some(Err(VerbError::Unreachable { .. }))),
            "{got:?}"
        );
    }
}
