//! one push to one device through its push service (rfc 8030): encrypt
//! (rfc 8291, aes128gcm), sign (rfc 8292), post, and read the answer.
//!
//! 201 is delivered to the push service, which is the only honest `ok` a
//! server can claim; 404 and 410 mean the subscription is gone and the
//! device is forgotten; 429, 5xx and network failures are tried again
//! twice with backoff; anything else is a failure with its status logged.

use std::time::{Duration, Instant};

use axum::http::HeaderValue;
use base64ct::{Base64UrlUnpadded, Encoding};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use web_push_native::WebPushBuilder;

use super::devices::Device;
use super::notice::Kind;
use super::vapid::{TOKEN_LIFETIME_S, Vapid};

const ATTEMPTS: u32 = 3;
const BACKOFF: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(10)];
/// a push service that asks for longer than this is treated as a failure.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// how much of a refusal's body is kept for the log.
const BODY_HEAD: usize = 200;

#[derive(Debug)]
pub enum Outcome {
    Accepted { status: u16 },
    Gone { status: u16 },
    Failed { status: Option<u16>, detail: String },
}

#[derive(Debug)]
pub struct Report {
    pub outcome: Outcome,
    pub attempts: u32,
    pub latency: Duration,
}

/// posts `body` to `device`, retrying what is worth retrying.
pub async fn deliver(
    client: &reqwest::Client,
    vapid: &Vapid,
    device: &Device,
    kind: Kind,
    tag: &str,
    body: &[u8],
) -> Report {
    let started = Instant::now();
    let mut attempts = 0;
    loop {
        attempts += 1;
        let (outcome, retry_after) = attempt(client, vapid, device, kind, tag, body).await;
        let retryable = retry_after.is_some();
        let wait = retry_after.flatten().or_else(|| {
            BACKOFF
                .get(usize::try_from(attempts - 1).unwrap_or(usize::MAX))
                .copied()
        });
        match wait {
            Some(wait) if retryable && attempts < ATTEMPTS && wait <= MAX_RETRY_AFTER => {
                tokio::time::sleep(wait).await;
            }
            _ => {
                return Report {
                    outcome,
                    attempts,
                    latency: started.elapsed(),
                };
            }
        }
    }
}

/// one post. the second value is `Some` when the failure is worth another
/// try, holding the push service's `Retry-After` if it sent one.
async fn attempt(
    client: &reqwest::Client,
    vapid: &Vapid,
    device: &Device,
    kind: Kind,
    tag: &str,
    body: &[u8],
) -> (Outcome, Option<Option<Duration>>) {
    let request = match build(vapid, device, kind, tag, body) {
        Ok(request) => request,
        Err(detail) => {
            return (
                Outcome::Failed {
                    status: None,
                    detail,
                },
                None,
            );
        }
    };
    let response = match client.execute(request).await {
        Ok(response) => response,
        Err(error) => {
            let detail = crate::upstream::plain(&error);
            return (
                Outcome::Failed {
                    status: None,
                    detail,
                },
                Some(None),
            );
        }
    };
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    let code = status.as_u16();
    if status.is_success() {
        return (Outcome::Accepted { status: code }, None);
    }
    if matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE) {
        return (Outcome::Gone { status: code }, None);
    }
    let text = response.text().await.unwrap_or_default();
    let detail: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail: String = detail.chars().take(BODY_HEAD).collect();
    let failed = Outcome::Failed {
        status: Some(code),
        detail,
    };
    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        (failed, Some(retry_after))
    } else {
        (failed, None)
    }
}

fn build(
    vapid: &Vapid,
    device: &Device,
    kind: Kind,
    tag: &str,
    body: &[u8],
) -> Result<reqwest::Request, String> {
    let endpoint = device
        .endpoint
        .as_str()
        .parse()
        .map_err(|e| format!("the endpoint is not a uri: {e}"))?;
    let lifetime = Duration::from_secs(TOKEN_LIFETIME_S.unsigned_abs());
    let built = WebPushBuilder::new(
        endpoint,
        device.p256dh,
        web_push_native::Auth::clone_from_slice(&device.auth),
    )
    .with_valid_duration(lifetime)
    .build(body.to_vec())
    .map_err(|e| format!("encryption failed: {e}"))?;
    let (mut parts, encrypted) = built.into_parts();

    let audience = device.endpoint.origin().ascii_serialization();
    let now_s = crate::now_ms() / 1000;
    let header = |text: String| HeaderValue::from_str(&text).map_err(|e| e.to_string());
    parts.headers.insert(
        "authorization",
        header(vapid.authorization(&audience, now_s))?,
    );
    // an ask or a fault may wake a sleeping phone; the rest can wait for it
    let urgency = match kind {
        Kind::Ask | Kind::Fault => "high",
        Kind::Done | Kind::Ready => "normal",
    };
    parts
        .headers
        .insert("urgency", HeaderValue::from_static(urgency));
    // while the device is offline the push service keeps only the newest
    // message per topic, so a thread's banners collapse there too
    parts.headers.insert("topic", header(topic(tag))?);

    let url = reqwest::Url::parse(&parts.uri.to_string()).map_err(|e| e.to_string())?;
    let mut request = reqwest::Request::new(reqwest::Method::POST, url);
    *request.headers_mut() = parts.headers;
    *request.body_mut() = Some(encrypted.into());
    *request.timeout_mut() = Some(REQUEST_TIMEOUT);
    Ok(request)
}

/// a topic is at most 32 base64url characters (rfc 8030, 5.4): the first
/// 16 bytes of the tag's sha-256 make 22.
fn topic(tag: &str) -> String {
    let digest = Sha256::digest(tag.as_bytes());
    Base64UrlUnpadded::encode_string(&digest[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_topic_is_short_url_safe_and_stable_per_thread() {
        let a = topic("thread:desk:ses_1");
        assert_eq!(a.len(), 22);
        assert!(
            a.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_eq!(a, topic("thread:desk:ses_1"));
        assert_ne!(a, topic("thread:desk:ses_2"));
    }
}
