//! contract 2's typed verbs on the cmx2 source: each turns boxbox's neutral
//! send, answer or read into the daemon call contract 1's handler makes
//! (the inherent methods beside this file), and the daemon's answer and
//! refusals into boxbox's own (`docs/agents.md`, section 4).
//!
//! a send names its attachments by media id; the source reads them from
//! the store and builds the `data:` urls cmx2 takes, under the photo memory
//! budget that bounds contract 1's route (`http/mod.rs`), so the bytes are
//! held once and only while the daemon takes them.

use std::sync::Arc;
use std::time::Duration;

use axum::response::Response;
use base64ct::{Base64, Encoding};
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::http::compose::{
    Document, Photo, accept_timeout, content, message_body, model_and_effort,
};
use crate::http::error::ApiError;
use crate::media::{Lookup, Media};
use crate::source::cmx2::Cmx2Source;
use crate::source::{
    Answer, Archived, AskRef, Catalog, CatalogModel, Reply, ThreadFacts, ThreadRef, VerbError,
};
use crate::wire::{Accepted, AcceptedState, AskKind, Born, Send, Start};

const MIB: u64 = 1024 * 1024;
/// a daemon's refusal of a passed-through verb is read this far, at most.
const REFUSAL_BYTES: usize = 64 * 1024;
/// the efforts a new session takes by name (`http/compose.rs`).
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// a contract 1 refusal in the source's neutral words. the daemon's own
/// refusals keep their words; a host that could not be reached keeps the
/// reason a person can act on.
pub fn verb_error(error: ApiError) -> VerbError {
    match error {
        ApiError::UnknownHost(_) => VerbError::Missing { what: "agent" },
        ApiError::NoSuchSession(_) => VerbError::Missing { what: "thread" },
        ApiError::Gone => VerbError::Gone,
        ApiError::Settled { by, at } => VerbError::Settled { by, at },
        ApiError::AlreadySent => VerbError::AlreadySent,
        ApiError::HostSaid {
            status, message, ..
        } => VerbError::Refused {
            status,
            words: message,
        },
        ApiError::BadRequest(words) => VerbError::Bad(words),
        ApiError::HostUnreachable { reason, .. } => VerbError::Unreachable { reason },
        ApiError::HostFailed { detail, .. } => VerbError::Unreachable { reason: detail },
        other => VerbError::Unreachable {
            reason: other.to_string(),
        },
    }
}

/// what cmx2 calls a session: the thread id, checked as one path segment.
/// the one field of a new session's info a fork reads.
#[derive(serde::Deserialize)]
struct NewSession {
    id: String,
}

/// the thread a fork made, from the daemon's answer: the new session.
fn forked(agent: &str, info: &serde_json::value::RawValue) -> Result<Born, VerbError> {
    let made = serde_json::from_str::<NewSession>(info.get())
        .ok()
        .filter(|s| crate::http::asks::segment(&s.id).is_ok())
        .ok_or_else(|| VerbError::Unreachable {
            reason: "its answer to the fork was not a session".into(),
        })?;
    Ok(Born {
        key: format!("{agent}:{}", made.id),
        thread: made.id,
    })
}

/// a fork the daemon refused. its 409 is history imported from cmx, which
/// it keeps browse only; said in boxbox's words, since the daemon's name
/// the session by id.
fn fork_refused(error: ApiError) -> VerbError {
    match error {
        ApiError::HostSaid { status: 409, .. } => VerbError::Refused {
            status: 409,
            words: "history imported from cmx is browse only, so it cannot be forked".into(),
        },
        other => verb_error(other),
    }
}

fn session(thread: &ThreadRef) -> Result<&str, VerbError> {
    crate::http::asks::segment(&thread.id).map_err(verb_error)
}

/// a send's attachments read from the store, each as the photo or the file
/// contract 1 takes (an image is a photo, anything else a file), with the
/// room they hold in the photo budget until dropped.
struct Read {
    photos: Vec<Photo>,
    files: Vec<Document>,
    _room: Option<tokio::sync::OwnedSemaphorePermit>,
}

async fn read_attachments(
    media: &Media,
    budget: &Arc<Semaphore>,
    send: &Send,
) -> Result<Read, VerbError> {
    if send.attachments.is_empty() {
        return Ok(Read {
            photos: Vec::new(),
            files: Vec::new(),
            _room: None,
        });
    }
    let mut objects = Vec::with_capacity(send.attachments.len());
    for attachment in &send.attachments {
        match media.lookup(&attachment.media).await {
            Ok(Lookup::Ready(object)) => objects.push(object),
            Ok(Lookup::Evicted | Lookup::Unknown) => {
                return Err(VerbError::Bad(
                    "an attachment is no longer on the server; attach it again".into(),
                ));
            }
            Err(error) => {
                return Err(VerbError::Unreachable {
                    reason: format!("the media store did not answer ({error})"),
                });
            }
        }
    }
    // the file and its base64 are held together while the url is built: about
    // 2.4 times the file, counted in whole MiB, never past what the budget holds
    let weight: u64 = objects.iter().map(|o| (o.size * 7).div_ceil(3)).sum();
    let mib = u32::try_from(weight.div_ceil(MIB).max(1))
        .unwrap_or(u32::MAX)
        .min(u32::try_from(crate::http::PHOTO_BUDGET_MIB).unwrap_or(u32::MAX));
    let room = tokio::time::timeout(
        Duration::from_secs(120),
        Arc::clone(budget).acquire_many_owned(mib),
    )
    .await
    .map_err(|_| VerbError::Busy)?
    .map_err(|_| VerbError::Busy)?;
    let mut photos = Vec::with_capacity(objects.len());
    let mut files = Vec::new();
    for object in objects {
        let Some(path) = media.path_of(&object.id) else {
            return Err(VerbError::Bad("that is not a media id".into()));
        };
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| VerbError::Unreachable {
                reason: format!("an attachment could not be read from the media store ({error})"),
            })?;
        let mut url = format!("data:{};base64,", object.mime);
        url.push_str(&Base64::encode_string(&bytes));
        drop(bytes);
        match attached(object.mime, object.filename, url) {
            Attached::Photo(photo) => photos.push(photo),
            Attached::File(file) => files.push(file),
        }
    }
    Ok(Read {
        photos,
        files,
        _room: Some(room),
    })
}

/// a stored attachment as contract 1 takes it: an image is a photo, anything else a file, which needs a name.
enum Attached {
    Photo(Photo),
    File(Document),
}

fn attached(mime: String, filename: Option<String>, url: String) -> Attached {
    if mime.starts_with("image/") {
        Attached::Photo(Photo {
            mime,
            filename,
            url,
        })
    } else {
        Attached::File(Document {
            mime,
            filename: filename.unwrap_or_else(|| "attachment".into()),
            url,
        })
    }
}

/// the daemon's body for a send, with how long it may take to take it.
fn body(
    send: &Send,
    photos: Vec<Photo>,
    files: Vec<Document>,
) -> Result<(Value, Duration), VerbError> {
    let limit = accept_timeout(&photos, &files);
    let parts = content(&send.text, photos, files).map_err(verb_error)?;
    let mut payload = message_body(parts, &send.client_id);
    model_and_effort(&mut payload, send.model.as_deref(), send.effort.as_deref())
        .map_err(verb_error)?;
    Ok((payload, limit))
}

fn accepted(answer: &Value) -> Accepted {
    Accepted {
        state: AcceptedState::Accepted,
        message: answer["messageID"].as_str().map(str::to_owned),
    }
}

/// a passed-through answer read as an outcome: a 2xx is done, with its json;
/// anything else is the daemon's refusal in its words.
async fn passed(response: Response, missing: VerbError) -> Result<Value, VerbError> {
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), REFUSAL_BYTES * 64)
        .await
        .map_err(|error| VerbError::Unreachable {
            reason: format!("the daemon's answer did not arrive whole ({error})"),
        })?;
    if (200..300).contains(&status) {
        return Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null));
    }
    if status == 404 {
        return Err(missing);
    }
    let words = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| {
            v["data"]["message"]
                .as_str()
                .or_else(|| v["error"]["message"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).into_owned());
    Err(VerbError::Refused { status, words })
}

impl Cmx2Source {
    pub(crate) async fn typed_prompt(
        &self,
        thread: &ThreadRef,
        send: Send,
    ) -> Result<Accepted, VerbError> {
        let id = session(thread)?;
        let read = read_attachments(&self.media, &self.photos, &send).await?;
        let (payload, limit) = body(&send, read.photos, read.files)?;
        let done = self.prompt(id, payload, limit).await.map_err(verb_error)?;
        Ok(accepted(&done.answer))
    }

    pub(crate) async fn typed_steer(
        &self,
        thread: &ThreadRef,
        send: Send,
    ) -> Result<Accepted, VerbError> {
        let id = session(thread)?;
        let read = read_attachments(&self.media, &self.photos, &send).await?;
        let (payload, limit) = body(&send, read.photos, read.files)?;
        let done = self.steer(id, payload, limit).await.map_err(verb_error)?;
        Ok(accepted(&done.answer))
    }

    pub(crate) async fn typed_queue(
        &self,
        thread: &ThreadRef,
        send: Send,
    ) -> Result<Accepted, VerbError> {
        let id = session(thread)?;
        let read = read_attachments(&self.media, &self.photos, &send).await?;
        let (payload, _) = body(&send, read.photos, read.files)?;
        let bytes = serde_json::to_vec(&payload).map_err(|e| VerbError::Bad(e.to_string()))?;
        drop(payload);
        let answer = self.queue_raw(id, bytes).await.map_err(verb_error)?;
        let answer = passed(answer, VerbError::Missing { what: "thread" }).await?;
        Ok(accepted(&answer))
    }

    pub(crate) async fn typed_abort(&self, thread: &ThreadRef) -> Result<(), VerbError> {
        let id = session(thread)?;
        self.abort(id).await.map(drop).map_err(verb_error)
    }

    pub(crate) async fn typed_compact(&self, thread: &ThreadRef) -> Result<(), VerbError> {
        let id = session(thread)?;
        self.compact(id).await.map(drop).map_err(verb_error)
    }

    pub(crate) async fn typed_run_now(&self, thread: &ThreadRef) -> Result<(), VerbError> {
        let id = session(thread)?;
        let answer = self.run_now_raw(id).await.map_err(verb_error)?;
        passed(answer, VerbError::Missing { what: "thread" })
            .await
            .map(drop)
    }

    pub(crate) async fn typed_unsend(
        &self,
        thread: &ThreadRef,
        message: &str,
    ) -> Result<(), VerbError> {
        let id = session(thread)?;
        let message = crate::http::asks::segment(message).map_err(verb_error)?;
        let answer = self.unsend_raw(id, message).await.map_err(verb_error)?;
        match passed(answer, VerbError::Gone).await {
            Err(VerbError::Refused { status: 409, .. }) => Err(VerbError::AlreadySent),
            other => other.map(drop),
        }
    }

    pub(crate) async fn typed_answer(
        &self,
        ask: &AskRef,
        answer: crate::source::Answer,
    ) -> Result<(), VerbError> {
        let id = crate::http::asks::segment(&ask.id).map_err(verb_error)?;
        let by = answer.device_class;
        let client = answer.client_id;
        let done = match (ask.kind, answer.reply) {
            (AskKind::Permission, Reply::Option(reply)) => {
                self.permission(id, &json!({ "reply": reply, "by": by, "clientID": client }))
                    .await
            }
            (AskKind::Question, Reply::Answers(answers)) => {
                self.question(
                    id,
                    &json!({ "answers": answers, "by": by, "clientID": client }),
                )
                .await
            }
            (AskKind::Question, Reply::Reject) => {
                self.reject(id, &json!({ "by": by, "clientID": client }))
                    .await
            }
            _ => {
                return Err(VerbError::Bad(
                    "answer a permission with an option, a question with answers or reject".into(),
                ));
            }
        };
        done.map(drop).map_err(verb_error)
    }

    pub(crate) async fn typed_archive(&self, thread: &ThreadRef) -> Result<Archived, VerbError> {
        let id = session(thread)?;
        #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
        let asked = crate::now_ms() as f64;
        let info = self
            .archive_session(id, asked)
            .await
            .map_err(|error| match error {
                ApiError::Gone => VerbError::Missing { what: "thread" },
                other => verb_error(other),
            })?;
        let at = serde_json::from_str::<Value>(info.get())
            .ok()
            .and_then(|v| v["time"]["archived"].as_f64());
        Ok(Archived {
            key: thread.key(),
            at: Some(at.unwrap_or(asked)),
        })
    }

    /// forks a session, whole or before one of its messages. a 404 is read
    /// again to say which is missing: the session, or the message in it.
    pub(crate) async fn typed_fork(
        &self,
        thread: &ThreadRef,
        before: Option<&str>,
    ) -> Result<Born, VerbError> {
        let id = session(thread)?;
        let before = before
            .map(|m| crate::http::asks::segment(m).map_err(verb_error))
            .transpose()?;
        match self.fork_session(id, before).await {
            Ok(info) => forked(&thread.agent, &info),
            Err(ApiError::Gone) => Err(self.fork_missing(id, before).await),
            Err(other) => Err(fork_refused(other)),
        }
    }

    /// what a fork's 404 meant: with no message named, or with the session
    /// gone too, the thread; else the message, which the person picked as a
    /// turn of it.
    async fn fork_missing(&self, id: &str, before: Option<&str>) -> VerbError {
        if before.is_none() {
            return VerbError::Missing { what: "thread" };
        }
        match self.session_info(id).await {
            Ok(_) => VerbError::Missing { what: "turn" },
            Err(ApiError::Gone) => VerbError::Missing { what: "thread" },
            Err(other) => verb_error(other),
        }
    }

    pub(crate) async fn typed_adopt(&self, thread: &ThreadRef) -> Result<ThreadFacts, VerbError> {
        let id = session(thread)?;
        let info = self.session_info(id).await.map_err(|error| match error {
            ApiError::Gone => VerbError::Missing { what: "thread" },
            other => verb_error(other),
        })?;
        #[cfg(feature = "record")]
        crate::fleet::record::adopt_info(&thread.agent, &info);
        let facts = crate::source::cmx2::translate::thread_from_json(info).map_err(|error| {
            VerbError::Unreachable {
                reason: format!("its answer was not a session ({error})"),
            }
        })?;
        if facts.archived {
            return Err(VerbError::Missing { what: "thread" });
        }
        Ok(facts)
    }

    pub(crate) async fn typed_catalog(&self) -> Result<Catalog, VerbError> {
        let answer = self.provider_models().await.map_err(verb_error)?;
        let read = crate::http::hosts::read_models(&answer);
        Ok(Catalog {
            models: read
                .models
                .into_iter()
                .map(|m| CatalogModel {
                    id: m.id,
                    name: m.name,
                    provider: Some(m.provider),
                    levels: Some(m.efforts),
                })
                .collect(),
            default: read.default,
        })
    }

    pub(crate) async fn typed_start(&self, agent: &str, start: Start) -> Result<Born, VerbError> {
        let Some(place) = start.place.clone() else {
            return Err(VerbError::Bad(
                "name the repo by its absolute directory on the machine".into(),
            ));
        };
        if !place.starts_with('/') {
            return Err(VerbError::Bad(
                "name the repo by its absolute directory on the machine".into(),
            ));
        }
        let read = read_attachments(&self.media, &self.photos, &start.send).await?;
        let (prompt, limit) = body(&start.send, read.photos, read.files)?;
        let directory = if start.worktree {
            self.fresh_worktree(&place).await.map_err(verb_error)?
        } else {
            place
        };
        let mut session = json!({ "directory": directory });
        if let Some(model) = &start.send.model {
            session["model"] = Value::String(model.clone());
        }
        if let Some(effort) = start.send.effort.as_deref().filter(|e| EFFORTS.contains(e)) {
            session["effort"] = Value::String(effort.to_owned());
        }
        let id = self
            .new_session(&session, &directory)
            .await
            .map_err(verb_error)?;
        let born = Born {
            key: format!("{agent}:{id}"),
            thread: id.clone(),
        };
        let id = crate::http::asks::segment(&id).map_err(verb_error)?;
        self.prompt(id, prompt, limit).await.map_err(verb_error)?;
        Ok(born)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_image_is_a_photo_and_anything_else_a_named_file() {
        let url = || "data:x;base64,AAAA".to_owned();
        let Attached::Photo(photo) = attached("image/heic".into(), None, url()) else {
            panic!("a heic went as a file");
        };
        assert_eq!((photo.mime.as_str(), photo.filename), ("image/heic", None));
        let Attached::File(pdf) =
            attached("application/pdf".into(), Some("brief.pdf".into()), url())
        else {
            panic!("a pdf went as a photo");
        };
        assert_eq!(
            (pdf.mime.as_str(), pdf.filename.as_str()),
            ("application/pdf", "brief.pdf")
        );
        // a file with no name still goes by one, which cmx2 labels it with
        let Attached::File(unnamed) = attached("text/plain".into(), None, url()) else {
            panic!("a text file went as a photo");
        };
        assert_eq!(unnamed.filename, "attachment");
    }

    #[test]
    fn a_daemons_refusals_keep_their_meaning_and_words() {
        assert!(matches!(
            verb_error(ApiError::Settled {
                by: "iphone".into(),
                at: Some(4)
            }),
            VerbError::Settled { at: Some(4), .. }
        ));
        assert!(matches!(verb_error(ApiError::Gone), VerbError::Gone));
        let VerbError::Refused { status, words } = verb_error(ApiError::HostSaid {
            host: "vm-a".into(),
            status: 400,
            message: "directory /x does not exist".into(),
        }) else {
            panic!("a daemon's refusal stays a refusal");
        };
        assert_eq!(
            (status, words.as_str()),
            (400, "directory /x does not exist")
        );
        let VerbError::Unreachable { reason } = verb_error(ApiError::HostUnreachable {
            host: "vm-a".into(),
            reason: "cannot connect (refused)".into(),
        }) else {
            panic!("an unreachable host stays unreachable");
        };
        assert_eq!(reason, "cannot connect (refused)");
    }

    #[test]
    fn a_fork_answers_the_new_session_as_a_thread_of_the_same_agent() {
        let info = serde_json::value::RawValue::from_string(
            r#"{"id":"ses_new","title":"fix it (fork #1)","forkedFrom":{"sessionID":"ses_1"}}"#
                .into(),
        )
        .unwrap();
        let born = forked("desk", &info).unwrap();
        assert_eq!(
            (born.key.as_str(), born.thread.as_str()),
            ("desk:ses_new", "ses_new")
        );
        // an answer that is not a session, or names one by an id no route takes, is the daemon failing
        for bad in [r#"{"title":"x"}"#, r#"{"id":"../ses"}"#, "[]"] {
            let info = serde_json::value::RawValue::from_string(bad.into()).unwrap();
            assert!(matches!(
                forked("desk", &info),
                Err(VerbError::Unreachable { .. })
            ));
        }
    }

    #[test]
    fn a_fork_of_imported_history_is_refused_in_boxboxs_words() {
        let VerbError::Refused { status, words } = fork_refused(ApiError::HostSaid {
            host: "desk".into(),
            status: 409,
            message: "session ses_1 has no transcript here to fork".into(),
        }) else {
            panic!("a 409 stays a refusal");
        };
        assert_eq!(status, 409);
        assert!(words.contains("browse only"), "{words}");
        // anything else keeps the daemon's meaning
        assert!(matches!(
            fork_refused(ApiError::HostUnreachable {
                host: "desk".into(),
                reason: "refused".into()
            }),
            VerbError::Unreachable { .. }
        ));
    }

    #[test]
    fn a_send_becomes_the_body_contract_1_sends() {
        let send = Send {
            client_id: "c-1".into(),
            text: "hello".into(),
            attachments: Vec::new(),
            quote: None,
            model: Some("bench/fast".into()),
            effort: Some("high".into()),
            generation: None,
        };
        let (payload, limit) = body(&send, Vec::new(), Vec::new()).unwrap();
        assert_eq!(payload["clientID"], "c-1");
        assert_eq!(payload["parts"][0]["text"], "hello");
        assert_eq!(payload["model"]["providerID"], "bench");
        assert_eq!(payload["effort"], "high");
        assert_eq!(limit, accept_timeout(&[], &[]));
    }
}
