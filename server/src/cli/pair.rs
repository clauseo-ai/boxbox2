//! the client half of cmx2's pairing (cmx2-asks a12), for `boxbox init`:
//! the one-time token `cmx2 pair` prints is traded at the daemon's
//! `POST /pair` for a bearer credential, which init writes into the host's
//! `[[host]]` in `boxbox.toml`. the app pairs the same way from the machines
//! screen (`http/hosts.rs`), keeping the credential in `boxbox.db` instead.
//!
//! neither the token nor the credential is ever printed or logged.

use std::time::Duration;

use reqwest::{StatusCode, Url};
use serde::Deserialize;

use crate::config::{Credential, Secret};
use crate::upstream::paired::CLIENT_NAME;
use crate::upstream::{plain, route_url};

/// the daemon answers a pairing in milliseconds; a slower one is not there.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// the answer is a few hundred bytes; nothing larger is read.
const BODY_CAP: usize = 64 * 1024;
/// a token from `cmx2 pair` is 50-odd characters.
const TOKEN_MAX: usize = 512;

/// what the daemon answered: its id for this client, the credential, and
/// the daemon's own version and contract.
pub struct Pairing {
    pub id: String,
    pub credential: Secret,
    pub version: String,
    pub contract: i64,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum PairError {
    #[error(
        "{url} did not answer: {reason}. is the daemon running, and can this machine reach it?"
    )]
    Unreachable { url: String, reason: String },
    #[error("the daemon refused the token: {0}")]
    Refused(String),
    #[error("{0} has no POST /pair: is it a cmx2 daemon from 0.8 or later?")]
    Unsupported(String),
    #[error("{0}")]
    Failed(String),
}

#[derive(Deserialize)]
struct Answer {
    id: String,
    credential: String,
    scheme: String,
    version: String,
    contract: i64,
}

#[derive(Deserialize)]
struct ErrorAnswer {
    data: ErrorData,
}

#[derive(Deserialize)]
struct ErrorData {
    message: String,
}

/// the token in what a person gave: the token alone, the `token  <value>`
/// line, or everything `cmx2 pair` printed. `None` when there is none.
#[must_use]
pub fn token_in(text: &str) -> Option<String> {
    let lines = || text.lines().map(str::trim).filter(|l| !l.is_empty());
    let labelled = lines().find_map(|line| {
        let (label, rest) = line.split_once(char::is_whitespace)?;
        (label == "token").then(|| rest.trim().to_owned())
    });
    let token = labelled.or_else(|| lines().next().map(str::to_owned))?;
    usable(&token).then_some(token)
}

/// the url in a line a person pasted: the url alone, or the `url  <value>`
/// line `cmx2 pair` printed.
#[must_use]
pub fn url_in(line: &str) -> &str {
    let line = line.trim();
    match line.split_once(char::is_whitespace) {
        Some(("url", rest)) => rest.trim(),
        _ => line,
    }
}

fn usable(token: &str) -> bool {
    !token.is_empty() && token.len() <= TOKEN_MAX && !token.chars().any(char::is_whitespace)
}

/// trades the token for a credential. the client names itself `boxbox`,
/// which a name given to `cmx2 pair --name` overrides in `cmx2 pair --list`.
///
/// # Errors
/// the daemon cannot be reached, refuses the token, does not pair, or
/// answers with something boxbox cannot use.
pub async fn exchange(
    client: &reqwest::Client,
    url: &Url,
    token: &str,
) -> Result<Pairing, PairError> {
    let unreachable = |reason: String| PairError::Unreachable {
        url: shown(url),
        reason,
    };
    let sent = tokio::time::timeout(
        ANSWER_TIMEOUT,
        client
            .post(route_url(url, "/pair"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::json!({ "token": token, "name": CLIENT_NAME }).to_string())
            .send(),
    )
    .await;
    let response = match sent {
        Err(_) => {
            return Err(unreachable(format!(
                "no answer within {} s",
                ANSWER_TIMEOUT.as_secs()
            )));
        }
        Ok(Err(error)) => return Err(unreachable(plain(&error))),
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    let body = read_capped(response).await.map_err(unreachable)?;
    match status {
        StatusCode::UNAUTHORIZED => {
            return Err(PairError::Refused(message_of(&body).unwrap_or_else(|| {
                "it is not one this daemon issued, it was already used, or it expired. run cmx2 pair on the host for a fresh one".into()
            })));
        }
        StatusCode::NOT_FOUND => return Err(PairError::Unsupported(shown(url))),
        status if !status.is_success() => {
            let detail = message_of(&body).unwrap_or_else(|| "no reason given".into());
            return Err(PairError::Failed(format!(
                "the daemon answered {status}: {detail}"
            )));
        }
        _ => {}
    }
    let answer: Answer = serde_json::from_slice(&body).map_err(|e| {
        PairError::Failed(format!(
            "the daemon's answer did not read ({e}): is this a cmx2 daemon?"
        ))
    })?;
    let credential = Secret::new(answer.credential);
    if answer.scheme != "Bearer" || Credential::Bearer(credential.clone()).header().is_none() {
        return Err(PairError::Failed(format!(
            "the daemon paired, but its credential is not one boxbox can send. revoke it there with cmx2 pair --revoke {}",
            answer.id
        )));
    }
    Ok(Pairing {
        id: answer.id,
        credential,
        version: answer.version,
        contract: answer.contract,
    })
}

/// the daemon's own words for an error, which already say what to do.
fn message_of(body: &[u8]) -> Option<String> {
    let answer: ErrorAnswer = serde_json::from_slice(body).ok()?;
    let message = answer.data.message.trim();
    (!message.is_empty()).then(|| message.to_owned())
}

async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > BODY_CAP {
                    return Err(format!(
                        "it answered with more than {} kb: is this a cmx2 daemon?",
                        BODY_CAP / 1024
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(error) => return Err(plain(&error)),
        }
    }
}

/// the url without a trailing slash, as a person typed it.
fn shown(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// what `cmx2 pair` prints at the pinned commit
    /// (`packages/cli/src/commands/pair.ts`), with a made-up token.
    const PRINTED: &str = "url    http://desk:4096\n\
        token  cmx2p_AbCdEf-123_xyz\n\
        \n\
        the token works once, until 14:05 (10 minutes). paste both into the client (boxbox: machines, add host).\n\
        by hand: curl -s -X POST http://desk:4096/pair -H 'content-type: application/json' -d '{\"token\":\"cmx2p_AbCdEf-123_xyz\"}'\n";

    #[test]
    fn the_token_is_found_alone_on_its_line_or_in_everything_cmx2_pair_printed() {
        let token = Some("cmx2p_AbCdEf-123_xyz".to_owned());
        assert_eq!(token_in("cmx2p_AbCdEf-123_xyz\n"), token);
        assert_eq!(token_in("token  cmx2p_AbCdEf-123_xyz"), token);
        assert_eq!(token_in(PRINTED), token);
        assert_eq!(token_in("\n  \n"), None);
        assert_eq!(token_in("two words"), None, "a token has no spaces");
        assert_eq!(token_in(&"x".repeat(TOKEN_MAX + 1)), None);
    }

    #[test]
    fn the_url_is_found_alone_or_on_its_labelled_line() {
        assert_eq!(url_in("url    http://desk:4096"), "http://desk:4096");
        assert_eq!(url_in(" http://desk:4096 "), "http://desk:4096");
    }

    #[test]
    fn the_daemons_own_words_are_kept_for_a_refusal() {
        let body = br#"{"name":"UnauthorizedError","data":{"message":"that pairing token expired (they last 10 minutes); run cmx2 pair on the host for a fresh one"}}"#;
        assert_eq!(
            message_of(body).as_deref(),
            Some(
                "that pairing token expired (they last 10 minutes); run cmx2 pair on the host for a fresh one"
            )
        );
        assert_eq!(message_of(b"<html>"), None);
    }

    #[tokio::test]
    async fn a_daemon_that_is_not_there_is_named_with_what_to_check() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let Err(error) = exchange(&reqwest::Client::new(), &url, "cmx2p_x").await else {
            panic!("nothing listens there");
        };
        let text = error.to_string();
        assert!(
            text.starts_with(&format!(
                "http://127.0.0.1:{port} did not answer: cannot connect"
            )),
            "{text}"
        );
    }
}
