//! btw on the cmx2 source: a side question about a session (`POST
//! /session/:id/btw`), its list, a dismissal and a promotion. each goes to
//! the daemon through the source's own upstream helpers, its answer read
//! loosely into the neutral btw (`translate::btw`), its refusals said in
//! words that fit a btw. a daemon older than btw answers its routes with
//! cmx2's no-route 404, which reads as the capability missing.

use serde_json::{Value, json};
use tracing::warn;

use super::asks::{BODY_MAX, NO_ROUTE};
use super::typed::verb_error;
use crate::http::error::ApiError;
use crate::source::cmx2::{Cmx2Source, translate};
use crate::source::{ThreadRef, VerbError};
use crate::wire::{Btw, Capability};

/// the most of a session's btw list one read takes: cmx2 caps each answer
/// well under a frame, and past this the answer is the host's failure.
pub const BTW_LIST_BYTES: usize = 4 * 1024 * 1024;

/// which verb a refusal answers, for its words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verb {
    Ask,
    List,
    Dismiss,
    Promote,
}

/// the daemon's refusal of a btw verb, in the words that fit it: its
/// generic ones (gone, already sent, already answered) are written for asks
/// and sends.
fn btw_refusal(error: ApiError, verb: Verb) -> VerbError {
    match error {
        ApiError::HostSaid {
            status: 404,
            message,
            ..
        } if message.starts_with(NO_ROUTE) => VerbError::Unsupported(Capability::Btw),
        // on the session's own routes a 404 is the session; on one btw's, the btw
        ApiError::Gone if matches!(verb, Verb::Ask | Verb::List) => {
            VerbError::Missing { what: "thread" }
        }
        ApiError::Gone => VerbError::Gone,
        ApiError::Settled { .. } if verb == Verb::Promote => VerbError::Refused {
            status: 409,
            words: "only an answered btw can be added to the thread, and only once; wait for its answer, or read the thread again".into(),
        },
        ApiError::Settled { .. } => VerbError::Refused {
            status: 409,
            words: "this thread is history imported from cmx and takes no btw".into(),
        },
        ApiError::AlreadySent => VerbError::Refused {
            status: 409,
            words: "the agent is busy with this thread; try again in a moment".into(),
        },
        other => verb_error(other),
    }
}

/// a btw from the daemon's answer.
fn read_btw(answer: &Value) -> Result<Btw, VerbError> {
    let raw = serde_json::value::to_raw_value(answer).map_err(|e| unreadable(&e))?;
    translate::btw(&raw).map_err(|e| unreadable(&e))
}

fn unreadable(error: &serde_json::Error) -> VerbError {
    VerbError::Unreachable {
        reason: format!("the daemon's btw could not be read ({error})"),
    }
}

/// the session and a btw, each checked as one path segment.
fn segments<'a>(thread: &'a ThreadRef, btw: &'a str) -> Result<(&'a str, &'a str), VerbError> {
    let session = crate::http::asks::segment(&thread.id).map_err(verb_error)?;
    let btw = crate::http::asks::segment(btw).map_err(verb_error)?;
    Ok((session, btw))
}

impl Cmx2Source {
    /// one btw call: refused as unsupported without a call once this
    /// connection's daemon has said it has no btw routes, and remembered
    /// when it says so now.
    async fn btw_call(
        &self,
        method: reqwest::Method,
        route: &str,
        sent: Option<&Value>,
        cap: usize,
        verb: Verb,
    ) -> Result<Value, VerbError> {
        if self.btw_missing() {
            return Err(VerbError::Unsupported(Capability::Btw));
        }
        match self.upstream_new_route(method, route, sent, cap).await {
            Ok(done) => Ok(done.answer),
            Err(error) => {
                let refused = btw_refusal(error, verb);
                if matches!(refused, VerbError::Unsupported(Capability::Btw)) {
                    self.mark_btw_missing();
                }
                Err(refused)
            }
        }
    }

    /// asks a side question (`POST /session/:id/btw`); the daemon dedupes a
    /// retry by its client id.
    pub(crate) async fn typed_btw_ask(
        &self,
        thread: &ThreadRef,
        client_id: &str,
        question: &str,
    ) -> Result<Btw, VerbError> {
        let session = crate::http::asks::segment(&thread.id).map_err(verb_error)?;
        let answer = self
            .btw_call(
                reqwest::Method::POST,
                &format!("/session/{session}/btw"),
                Some(&json!({ "text": question, "clientID": client_id })),
                BODY_MAX,
                Verb::Ask,
            )
            .await?;
        read_btw(&answer)
    }

    /// the session's btws, oldest first (`GET /session/:id/btw`). one the
    /// source cannot read is left out and logged, so one bad row does not
    /// hide the rest.
    pub(crate) async fn typed_btws(&self, thread: &ThreadRef) -> Result<Vec<Btw>, VerbError> {
        let session = crate::http::asks::segment(&thread.id).map_err(verb_error)?;
        let answer = self
            .btw_call(
                reqwest::Method::GET,
                &format!("/session/{session}/btw"),
                None,
                BTW_LIST_BYTES,
                Verb::List,
            )
            .await?;
        let Value::Array(rows) = answer else {
            return Err(VerbError::Unreachable {
                reason: "the daemon's btw list was not a list".into(),
            });
        };
        let mut btws = Vec::with_capacity(rows.len());
        for row in &rows {
            match read_btw(row) {
                Ok(btw) => btws.push(btw),
                Err(error) => {
                    warn!(host = self.name(), session, %error, "a btw the daemon listed was left out");
                }
            }
        }
        Ok(btws)
    }

    /// dismisses a btw on every device (`POST /session/:id/btw/:btw/dismiss`).
    pub(crate) async fn typed_btw_dismiss(
        &self,
        thread: &ThreadRef,
        btw: &str,
    ) -> Result<Btw, VerbError> {
        let (session, btw) = segments(thread, btw)?;
        let answer = self
            .btw_call(
                reqwest::Method::POST,
                &format!("/session/{session}/btw/{btw}/dismiss"),
                Some(&json!({})),
                BODY_MAX,
                Verb::Dismiss,
            )
            .await?;
        read_btw(&answer)
    }

    /// adds a done btw to the thread as a user message (`POST
    /// /session/:id/btw/:btw/promote`): a steer while a turn runs (its id
    /// provisional until it lands), a prompt otherwise.
    pub(crate) async fn typed_btw_promote(
        &self,
        thread: &ThreadRef,
        btw: &str,
    ) -> Result<String, VerbError> {
        let (session, btw) = segments(thread, btw)?;
        let answer = self
            .btw_call(
                reqwest::Method::POST,
                &format!("/session/{session}/btw/{btw}/promote"),
                Some(&json!({})),
                BODY_MAX,
                Verb::Promote,
            )
            .await?;
        answer["messageID"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| VerbError::Unreachable {
                reason: "the daemon added the btw but did not name its message".into(),
            })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::config::HostConfig;

    /// a daemon that answers one request with `status` and `body`, and hands
    /// back the request line and body it was sent.
    fn daemon(
        status: u16,
        body: &'static str,
    ) -> (Arc<Cmx2Source>, std::sync::mpsc::Receiver<(String, String)>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0_u8; 4096];
            let (head, length) = loop {
                let n = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).into_owned();
                if let Some((head, _)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .and_then(|n| n.parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= head.len() + 4 + length {
                        break (head.to_owned(), length);
                    }
                }
            };
            let sent = &request[head.len() + 4..head.len() + 4 + length];
            let line = head.lines().next().unwrap_or_default().to_owned();
            let _ = seen.send((line, String::from_utf8_lossy(sent).into_owned()));
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        let config = HostConfig {
            name: "desk".into(),
            url: format!("http://127.0.0.1:{port}").parse().unwrap(),
            credential: None,
            origin: crate::config::Origin::Config,
        };
        let view = crate::upstream::HostView::detached(config, crate::wire::Capabilities::cmx2());
        (view.source, received)
    }

    fn thread() -> ThreadRef {
        ThreadRef {
            agent: "desk".into(),
            id: "ses_1".into(),
        }
    }

    const RUNNING: &str = r#"{"id":"btw_1","sessionID":"ses_1","text":"why?","answer":"","status":"running","afterMessageID":"msg_9","time":{"created":10}}"#;
    const NO_ROUTE_BODY: &str =
        r#"{"name":"NotFoundError","data":{"message":"no route for POST /session/ses_1/btw"}}"#;

    #[tokio::test]
    async fn asking_posts_the_question_and_client_id_and_reads_the_running_btw() {
        let (source, received) = daemon(200, RUNNING);
        let btw = source
            .typed_btw_ask(&thread(), "cid-1", "why?")
            .await
            .unwrap();
        assert_eq!(btw.id, "btw_1");
        assert_eq!(btw.question, "why?");
        assert_eq!(btw.after_message_id.as_deref(), Some("msg_9"));
        let (line, body) = received.recv().unwrap();
        assert_eq!(line, "POST /session/ses_1/btw HTTP/1.1");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"text": "why?", "clientID": "cid-1"})
        );
    }

    #[tokio::test]
    async fn an_older_daemon_without_the_route_is_a_daemon_without_btw() {
        let (source, _received) = daemon(404, NO_ROUTE_BODY);
        let error = source
            .typed_btw_ask(&thread(), "cid-1", "why?")
            .await
            .unwrap_err();
        assert!(
            matches!(error, VerbError::Unsupported(Capability::Btw)),
            "{error:?}"
        );
        // remembered for the connection: the next call never reaches a daemon
        // (the one-shot daemon is gone, so a call would be unreachable)
        assert!(source.btw_missing());
        let again = source.typed_btws(&thread()).await.unwrap_err();
        assert!(
            matches!(again, VerbError::Unsupported(Capability::Btw)),
            "{again:?}"
        );
    }

    #[tokio::test]
    async fn another_verbs_404_on_a_route_a_daemon_lacks_is_still_gone() {
        let (source, _received) = daemon(404, NO_ROUTE_BODY);
        let error = source
            .post("/session/ses_1/abort", &json!({}))
            .await
            .unwrap_err();
        assert!(matches!(error, ApiError::Gone), "{error:?}");
        assert!(!source.btw_missing());
    }

    #[tokio::test]
    async fn asking_on_a_session_the_daemon_does_not_have_is_no_such_thread() {
        let (source, _received) = daemon(
            404,
            r#"{"name":"NotFoundError","data":{"message":"no session ses_1"}}"#,
        );
        let error = source
            .typed_btw_ask(&thread(), "cid-1", "why?")
            .await
            .unwrap_err();
        assert!(
            matches!(error, VerbError::Missing { what: "thread" }),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn listing_gets_the_sessions_btws_and_leaves_out_one_it_cannot_read() {
        let body: &'static str = Box::leak(
            format!(r#"[{RUNNING},{{"id":"btw_2","text":"q","status":"thinking","time":{{"created":1}}}}]"#)
                .into_boxed_str(),
        );
        let (source, received) = daemon(200, body);
        let btws = source.typed_btws(&thread()).await.unwrap();
        assert_eq!(btws.len(), 1);
        assert_eq!(btws[0].id, "btw_1");
        let (line, _) = received.recv().unwrap();
        assert_eq!(line, "GET /session/ses_1/btw HTTP/1.1");
    }

    #[tokio::test]
    async fn dismissing_posts_to_the_btw_and_a_gone_one_is_gone() {
        let (source, received) = daemon(
            200,
            r#"{"id":"btw_1","sessionID":"ses_1","text":"why?","answer":"so","status":"done","time":{"created":10,"completed":11,"dismissed":12}}"#,
        );
        let btw = source.typed_btw_dismiss(&thread(), "btw_1").await.unwrap();
        assert_eq!(btw.dismissed, Some(12.0));
        let (line, body) = received.recv().unwrap();
        assert_eq!(line, "POST /session/ses_1/btw/btw_1/dismiss HTTP/1.1");
        assert_eq!(body, "{}");
        let (source, _received) = daemon(
            404,
            r#"{"name":"NotFoundError","data":{"message":"no btw btw_1 on session ses_1"}}"#,
        );
        let error = source
            .typed_btw_dismiss(&thread(), "btw_1")
            .await
            .unwrap_err();
        assert!(matches!(error, VerbError::Gone), "{error:?}");
    }

    #[tokio::test]
    async fn promoting_answers_the_message_and_a_running_btw_is_refused_in_btw_words() {
        let (source, received) = daemon(200, r#"{"messageID":"msg_10"}"#);
        let message = source.typed_btw_promote(&thread(), "btw_1").await.unwrap();
        assert_eq!(message, "msg_10");
        let (line, body) = received.recv().unwrap();
        assert_eq!(line, "POST /session/ses_1/btw/btw_1/promote HTTP/1.1");
        assert_eq!(body, "{}");
        let (source, _received) = daemon(
            409,
            r#"{"name":"ConflictError","data":{"message":"btw btw_1 is running; only an answered btw can be promoted"}}"#,
        );
        let error = source
            .typed_btw_promote(&thread(), "btw_1")
            .await
            .unwrap_err();
        let VerbError::Refused { status, words } = error else {
            panic!("{error:?}")
        };
        assert_eq!(status, 409);
        assert!(words.starts_with("only an answered btw"), "{words}");
    }

    #[test]
    fn a_daemon_without_the_route_reads_as_no_btw_and_a_gone_btw_as_gone() {
        let no_route = || ApiError::HostSaid {
            host: "desk".into(),
            status: 404,
            message: "no route for POST /session/ses_1/btw".into(),
        };
        for verb in [Verb::Ask, Verb::List, Verb::Dismiss, Verb::Promote] {
            assert!(matches!(
                btw_refusal(no_route(), verb),
                VerbError::Unsupported(Capability::Btw)
            ));
        }
        assert!(matches!(
            btw_refusal(ApiError::Gone, Verb::Ask),
            VerbError::Missing { what: "thread" }
        ));
        assert!(matches!(
            btw_refusal(ApiError::Gone, Verb::Dismiss),
            VerbError::Gone
        ));
        let VerbError::Refused { status, words } = btw_refusal(
            ApiError::Settled {
                by: "someone".into(),
                at: None,
            },
            Verb::Promote,
        ) else {
            panic!()
        };
        assert_eq!(status, 409);
        assert!(words.contains("answered btw"));
    }
}
