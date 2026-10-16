//! the cmx2 source's a steer, a shell line, slash commands, repos and
//! folders, a new thread (`http/compose.rs`): the daemon calls the
//! composer's verbs make, with the daemon's answer shaped and its refusals
//! said the way the composer shows them.

use std::time::Duration;

use reqwest::Method;
use serde_json::{Value, json};
use tracing::info;

use crate::http::asks::Done;
use crate::http::compose::{CommandChoice, Folder, Folders, ProjectChoice};
use crate::http::error::ApiError;
use crate::source::cmx2::Cmx2Source;

/// how long a read for a menu may take; the menu says so when it does not come.
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// a `!` line runs to the end before the daemon answers; its own limit is 600 s.
const SHELL_TIMEOUT: Duration = Duration::from_secs(610);
/// making a fresh worktree copies the checkout before it answers.
const BIRTH_TIMEOUT: Duration = Duration::from_secs(60);
/// the most folders one answer carries.
pub const FOLDERS_MAX: usize = 500;
/// the most of a host's folder list one read takes in.
const FOLDERS_BODY: usize = 4 * 1024 * 1024;

impl Cmx2Source {
    /// steers a message into the running turn (`POST /session/:id/steer`);
    /// `session` is already one segment and `limit` the daemon's own time to take it.
    ///
    /// # Errors
    /// the host could not be reached or refused boxbox's credential, or the
    /// daemon refused the message.
    pub async fn steer(
        &self,
        session: &str,
        sent: Value,
        limit: Duration,
    ) -> Result<Done, ApiError> {
        let route = format!("/session/{session}/steer");
        self.post_body(&route, sent, limit).await
    }

    /// runs a `!` line (`POST /session/:id/shell`); the daemon answers when it has finished.
    ///
    /// # Errors
    /// as `steer`.
    pub async fn shell(&self, session: &str, sent: &Value) -> Result<Done, ApiError> {
        let route = format!("/session/{session}/shell");
        self.upstream(Method::POST, &route, Some(sent), None, SHELL_TIMEOUT)
            .await
    }

    /// runs a `/` command (`POST /session/:id/command`). the daemon holds its answer until the command's turn
    /// settles: this answers once its headers say it was taken, and reads the rest in a task of its own
    /// (bounded by the turn) so the daemon is not cut off.
    ///
    /// # Errors
    /// as `steer`; a command the directory does not have is a bad request.
    pub async fn command(&self, session: &str, sent: &Value) -> Result<Done, ApiError> {
        let route = format!("/session/{session}/command");
        let route = route.as_str();
        let host = self.host().name.as_str();
        let unreachable = |reason: String| ApiError::HostUnreachable {
            host: host.to_owned(),
            reason,
        };
        let response = tokio::time::timeout(
            READ_TIMEOUT,
            crate::upstream::request(&self.client, self.host(), Method::POST, route)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(sent.to_string())
                .send(),
        )
        .await
        .map_err(|_| unreachable(format!("no answer within {}s", READ_TIMEOUT.as_secs())))?
        .map_err(|e| unreachable(crate::upstream::plain(&e)))?;
        let status = response.status().as_u16();
        info!(host, route, status, "command sent to the host");
        if status == 404 {
            return Err(ApiError::BadRequest(
                "the thread's directory has no command by that name".into(),
            ));
        }
        if !(200..300).contains(&status) {
            let body = response.text().await.unwrap_or_default();
            return Err(ApiError::HostSaid {
                host: host.to_owned(),
                status,
                message: body.chars().take(200).collect(),
            });
        }
        let repeat = response.headers().contains_key("x-cmx2-repeat");
        tokio::spawn(async move {
            // the command's own turn ends the body; an hour is past any turn worth waiting for
            let _ = tokio::time::timeout(Duration::from_secs(3600), response.bytes()).await;
        });
        Ok(Done {
            repeat,
            answer: Value::Null,
        })
    }

    /// the `/` commands a directory offers (`GET /command`), by name.
    ///
    /// # Errors
    /// as `steer`.
    pub async fn commands(&self, directory: &str) -> Result<Vec<CommandChoice>, ApiError> {
        let read = self
            .upstream(Method::GET, "/command", None, Some(directory), READ_TIMEOUT)
            .await?;
        let mut choices: Vec<CommandChoice> = read
            .answer
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                Some(CommandChoice {
                    name: c["name"].as_str()?.to_owned(),
                    description: c["description"].as_str().map(str::to_owned),
                    hints: c["hints"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|h| h.as_str().map(str::to_owned))
                        .collect(),
                    source: c["source"].as_str().unwrap_or("command").to_owned(),
                })
            })
            .collect();
        choices.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(choices)
    }

    /// the repos a new thread can start in (`GET /project`), as the daemon orders them.
    ///
    /// # Errors
    /// as `steer`.
    pub async fn projects(&self) -> Result<Vec<ProjectChoice>, ApiError> {
        let read = self
            .upstream(Method::GET, "/project", None, None, READ_TIMEOUT)
            .await?;
        Ok(read
            .answer
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some(ProjectChoice {
                    directory: p["worktree"].as_str()?.to_owned(),
                    updated: p["time"]["updated"].as_i64(),
                })
            })
            .collect())
    }

    /// the folders inside a folder (`GET /global/fs`); `query` is already in the daemon's query form, and
    /// `prefix` narrows the answer to the names that start with it.
    ///
    /// # Errors
    /// as `steer`; a folder the host cannot list is said in words.
    pub async fn folders(&self, query: &[String], prefix: &str) -> Result<Folders, ApiError> {
        let host = &self.host().name;
        let route = if query.is_empty() {
            "/global/fs".to_owned()
        } else {
            format!("/global/fs?{}", query.join("&"))
        };
        let read = self
            .upstream_within(Method::GET, &route, None, None, READ_TIMEOUT, FOLDERS_BODY)
            .await
            .map_err(|error| folder_refusal(host, error))?;
        shape_folders(&read.answer, prefix).ok_or_else(|| ApiError::HostFailed {
            host: host.clone(),
            detail: "its folder list came back in a shape this server does not read".into(),
        })
    }

    /// a fresh worktree of the repo at `directory` (`POST /experimental/worktree`): the directory it made.
    ///
    /// # Errors
    /// as `steer`, or its answer named no directory.
    pub async fn fresh_worktree(&self, directory: &str) -> Result<String, ApiError> {
        let made = self
            .upstream(
                Method::POST,
                "/experimental/worktree",
                Some(&json!({})),
                Some(directory),
                BIRTH_TIMEOUT,
            )
            .await?;
        made.answer["directory"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| ApiError::HostFailed {
                host: self.host().name.clone(),
                detail: "its new worktree named no directory".into(),
            })
    }

    /// a new session (`POST /session`) with `session` as its body, in `directory`: its id.
    ///
    /// # Errors
    /// as `steer`; nothing at `directory` is a bad request, and a session without an id the host's failure.
    pub async fn new_session(&self, session: &Value, directory: &str) -> Result<String, ApiError> {
        let host = &self.host().name;
        let made = self
            .upstream(Method::POST, "/session", Some(session), None, READ_TIMEOUT)
            .await
            .map_err(|error| missing_directory(host, directory, error))?;
        made.answer["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| ApiError::HostFailed {
                host: host.clone(),
                detail: "its new session had no id".into(),
            })
    }
}

/// cmx2's `/global/fs` answer as boxbox serves it, narrowed to a name prefix and bounded; none when it is
/// not that shape.
pub fn shape_folders(answer: &Value, prefix: &str) -> Option<Folders> {
    let prefix = prefix.to_lowercase();
    let mut matched = answer["entries"]
        .as_array()?
        .iter()
        .filter_map(|e| {
            let name = e["name"].as_str()?;
            if !name.to_lowercase().starts_with(&prefix) {
                return None;
            }
            Some(Folder {
                name: name.to_owned(),
                directory: e["absolute"].as_str()?.to_owned(),
                repo: e["git"].as_bool().unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    let truncated = matched.len() > FOLDERS_MAX;
    matched.truncate(FOLDERS_MAX);
    Some(Folders {
        path: answer["path"].as_str()?.to_owned(),
        parent: answer["parent"].as_str().map(str::to_owned),
        home: answer["home"].as_str()?.to_owned(),
        children: matched,
        truncated,
    })
}

/// what the daemon's refusal to list a folder means to the person, in words: nothing there, a file, or no
/// permission. anything else it said stays its own.
#[must_use]
pub fn folder_refusal(host: &str, error: ApiError) -> ApiError {
    let ApiError::HostSaid {
        status: 400,
        message,
        ..
    } = &error
    else {
        return error;
    };
    let at = |prefix: &str| message.strip_prefix(prefix).map(str::to_owned);
    if let Some(path) = at("no such directory: ") {
        return ApiError::BadRequest(format!("there is no folder at {path} on {host}."));
    }
    if let Some(path) = at("not a directory: ") {
        let name = path.rsplit('/').next().unwrap_or(&path);
        return ApiError::BadRequest(format!("{name} is a file, not a folder."));
    }
    if let Some(path) = at("permission denied: ") {
        return ApiError::BadRequest(format!("{path} on {host} cannot be read."));
    }
    error
}

/// a thread asked to start where the host has no folder: said as what happened and what to do, a refusal the
/// client never retries (the daemon says "directory X does not exist" for a missing folder and for a file).
#[must_use]
pub fn missing_directory(host: &str, directory: &str, error: ApiError) -> ApiError {
    match &error {
        ApiError::HostSaid {
            status: 400,
            message,
            ..
        } if message.contains("does not exist") => ApiError::BadRequest(format!(
            "nothing at {directory} on {host}, so the thread did not start. pick another folder, or make it and retry."
        )),
        _ => error,
    }
}
