//! the bytes a device receives: json the service worker turns into a
//! notification (`app/src/push/payload.ts` is the same shape).
//!
//! - one banner per thread: the tag is the thread, so newer news replaces
//!   older instead of stacking.
//! - actions deep-link into the app. an ask carries "answer" (the thread
//!   with the ask focused) and "open" (the thread); the other kinds carry
//!   "open". tapping the banner itself takes the first action's link, which
//!   is all ios offers: it shows no action buttons (`docs/push.md`).
//! - the link is `/?thread=<host:session>[&ask=<id>]&push=<id>`; the app
//!   reads it at boot or from the worker's message and then clears it with
//!   `replaceState`, so no history entry is pushed.

use std::fmt::Write;

use serde::Serialize;

use super::notice::{About, Kind, Notice};

/// title and body are trimmed to these many characters. a lock screen
/// shows about four lines; the rest belongs in the app.
pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_BODY_CHARS: usize = 240;
/// the encrypted body must stay under 4096 bytes (rfc 8291, one record:
/// 86 bytes of header, 17 of tag and padding); this leaves room to spare.
pub const MAX_PAYLOAD_BYTES: usize = 3072;
/// the payload's shape; the worker ignores versions it does not know.
pub const VERSION: u8 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload<'a> {
    pub v: u8,
    pub id: &'a str,
    pub kind: Kind,
    /// question | permission | done | fault | ready, for telemetry.
    pub need: &'static str,
    pub tag: String,
    pub thread: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<&'a str>,
    pub title: String,
    pub body: String,
    /// where tapping the banner goes.
    pub url: String,
    pub actions: Vec<Action>,
    /// the device this copy was encrypted for, and its class, so the
    /// worker's telemetry is the device's own.
    pub device: &'a str,
    pub device_class: &'a str,
    /// server clock, ms; the worker reports delivery latency against it.
    pub sent_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Action {
    /// the id `notificationclick` reports as `event.action`.
    #[serde(rename = "action")]
    pub name: &'static str,
    pub title: &'static str,
    pub url: String,
}

/// the tag every notification for `thread` carries.
#[must_use]
pub fn tag(thread: &str) -> String {
    format!("thread:{thread}")
}

impl<'a> Payload<'a> {
    #[must_use]
    pub fn new(notice: &'a Notice, device: &'a str, device_class: &'a str, sent_at: i64) -> Self {
        let thread = notice.thread.key();
        let open = link(thread, None, &notice.id);
        let (ask, actions) = match &notice.about {
            About::Ask { id, .. } => (
                Some(id.as_str()),
                vec![
                    Action {
                        name: "answer",
                        title: "answer",
                        url: link(thread, Some(id), &notice.id),
                    },
                    Action {
                        name: "open",
                        title: "open",
                        url: open,
                    },
                ],
            ),
            About::Done | About::Fault | About::Ready => (
                None,
                vec![Action {
                    name: "open",
                    title: "open",
                    url: open,
                }],
            ),
        };
        let url = actions.first().map(|a| a.url.clone()).unwrap_or_default();
        Self {
            v: VERSION,
            id: &notice.id,
            kind: notice.about.kind(),
            need: notice.about.need(),
            tag: tag(thread),
            thread,
            ask,
            title: trim(&notice.title, MAX_TITLE_CHARS),
            body: trim(&notice.body, MAX_BODY_CHARS),
            url,
            actions,
            device,
            device_class,
            sent_at,
            badge: notice.badge,
        }
    }

    /// the json, or `None` if it would not fit a push (only reachable with
    /// ids far longer than any daemon mints).
    #[must_use]
    pub fn to_bytes(&self) -> Option<Vec<u8>> {
        serde_json::to_vec(self)
            .ok()
            .filter(|bytes| bytes.len() <= MAX_PAYLOAD_BYTES)
    }
}

fn link(thread: &str, ask: Option<&str>, push: &str) -> String {
    let mut url = format!("/?thread={}", encode(thread));
    if let Some(ask) = ask {
        url.push_str("&ask=");
        url.push_str(&encode(ask));
    }
    url.push_str("&push=");
    url.push_str(&encode(push));
    url
}

/// percent-encodes all but the unreserved set (rfc 3986) and `:`, which is
/// legal in a query and keeps `host:session` readable.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b':') {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// collapses whitespace runs and keeps at most `max` characters, ending in
/// "..." when cut.
fn trim(text: &str, max: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        return collapsed;
    }
    let kept: String = collapsed.chars().take(max.saturating_sub(3)).collect();
    format!("{}...", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::notice::{AskKind, Origin, Thread};

    fn notice(about: About, body: &str) -> Notice {
        Notice {
            id: "ask:que_1".into(),
            about,
            thread: Thread::parse("desk:ses_1").unwrap(),
            title: "ledger wants you".into(),
            body: body.into(),
            origin: Origin::default(),
            badge: Some(2),
        }
    }

    #[test]
    fn an_ask_answers_into_the_focused_ask_and_opens_into_the_thread() {
        let about = About::Ask {
            id: "que_1".into(),
            kind: AskKind::Question,
        };
        let notice = notice(about, "which greeting?");
        let payload = Payload::new(&notice, "d1", "mac", 1000);
        assert_eq!(payload.tag, "thread:desk:ses_1");
        assert_eq!(payload.need, "question");
        assert_eq!(
            payload.actions,
            vec![
                Action {
                    name: "answer",
                    title: "answer",
                    url: "/?thread=desk:ses_1&ask=que_1&push=ask:que_1".into(),
                },
                Action {
                    name: "open",
                    title: "open",
                    url: "/?thread=desk:ses_1&push=ask:que_1".into(),
                },
            ]
        );
        assert_eq!(payload.url, payload.actions[0].url, "a plain tap answers");
    }

    #[test]
    fn a_done_only_opens() {
        let notice = notice(About::Done, "118 passed.");
        let payload = Payload::new(&notice, "d1", "mac", 1000);
        let actions: Vec<_> = payload.actions.iter().map(|a| a.name).collect();
        assert_eq!(actions, ["open"]);
        assert!(payload.ask.is_none());
    }

    #[test]
    fn long_text_is_trimmed_to_a_banner_and_the_payload_fits_a_push() {
        let body = "word ".repeat(2000);
        let mut long = notice(About::Fault, &body);
        long.title = "t".repeat(500);
        let payload = Payload::new(&long, "d1", "mac", 1000);
        assert_eq!(payload.body.chars().count(), MAX_BODY_CHARS);
        assert!(payload.body.ends_with("..."));
        assert_eq!(payload.title.chars().count(), MAX_TITLE_CHARS);
        assert!(payload.to_bytes().is_some());
    }

    #[test]
    fn links_encode_what_a_query_cannot_hold() {
        assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
        assert_eq!(encode("desk:ses_1"), "desk:ses_1");
    }
}
