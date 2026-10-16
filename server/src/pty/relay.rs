//! one relay per open terminal: the browser's socket on one side, the
//! host's pty websocket on the other, and a pump each way between them
//! (architecture: the pty relay, 256 kb each way).
//!
//! **down** (host to browser): output goes into a queue the browser's
//! writer drains. a replay waits for room, since cmx2 bounds it by what it
//! retains; live output that finds the queue full means the browser has
//! fallen behind, so the relay lets go of the host, lets the browser catch
//! up, and redials with its cursor. the host keeps what it keeps; the
//! relay never holds more than the cap.
//!
//! **up** (browser to host): typed input goes into a queue the host's
//! writer drains. input that finds it full means the terminal is not
//! reading; the relay closes the browser's socket with a code that says
//! so, and the browser redials with its cursor.
//!
//! when the host's connection drops or goes quiet, the relay redials it
//! with its cursor and tells the browser a replay is restarting
//! (`protocol.rs`); the browser's socket stays open throughout. it gives
//! up after 30 s and closes the browser's socket with a code the pane
//! reads as "not answering".
//!
//! the relay is one task. its parts run concurrently inside it and share
//! nothing but the two queues and a few counters.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use bytes::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::time::{MissedTickBehavior, interval_at, sleep, sleep_until, timeout};
use tokio_tungstenite::tungstenite::{self, Message as HostMessage};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::dial::{DialError, Dialer, Socket, plain};
use super::protocol::{self, Position, Settled, Upstream};
use super::pump::{Drain, Feed, pump};
use super::telemetry::{Row, Stamp, emit};
use crate::source::cmx2::Cmx2Source;
use crate::upstream::backoff::Backoff;

/// each pump's byte budget (architecture: memory caps).
pub const CAP: usize = 256 * 1024;
/// each pump's frame budget: a flood of one-byte frames is a flood too.
const FRAMES: usize = 1024;
/// after an overflow the relay redials once the browser has this little
/// left to take, so it keeps receiving while the dial happens.
const LOW_WATER: usize = CAP / 4;
/// each end hears from the other at least this often...
const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
/// ...and gives up on it after this long without a byte (architecture:
/// liveness).
const SILENCE: Duration = Duration::from_secs(45);
/// how long the relay keeps redialling a host it lost.
const GIVE_UP: Duration = Duration::from_secs(30);
const REDIAL_FLOOR: Duration = Duration::from_millis(250);
const REDIAL_CAP: Duration = Duration::from_secs(5);
/// how long the browser gets to take the last output and the close.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

/// close codes the pane reads (docs/terminal.md). 1000 is cmx2's own,
/// passed through: the shell exited.
pub mod code {
    pub const EXITED: u16 = 1000;
    pub const STOPPING: u16 = 1001;
    pub const REFUSED: u16 = 4401;
    pub const GONE: u16 = 4404;
    pub const INPUT_BACKED_UP: u16 = 4413;
    pub const UNREACHABLE: u16 = 4502;
}

/// the terminal a relay serves.
#[derive(Debug, Clone)]
pub struct Target {
    pub source: Arc<Cmx2Source>,
    pub pty: String,
}

/// everything a relay needs besides its sockets.
#[derive(Debug)]
pub struct Relay {
    pub target: Target,
    pub dialer: Dialer,
    pub telemetry: crate::telemetry::Sender,
    pub stamp: Stamp,
    pub shutdown: CancellationToken,
    /// ties this relay's log lines together.
    pub id: String,
}

/// why a relay ended, and what the browser is told.
#[derive(Debug, Clone, PartialEq, Eq)]
enum End {
    /// the browser closed its socket or stopped taking bytes.
    Closed,
    /// the shell exited; cmx2's close reason.
    Exited(String),
    /// the host no longer has the terminal (it was killed, or the daemon
    /// restarted, which ends every terminal it held).
    Gone,
    Unreachable(String),
    Refused,
    /// the browser went 45 s without a byte.
    Stalled,
    InputBackedUp,
    Shutdown,
}

impl End {
    fn label(&self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Exited(_) => "exited",
            Self::Gone => "gone",
            Self::Unreachable(_) => "unreachable",
            Self::Refused => "refused",
            Self::Stalled => "stalled",
            Self::InputBackedUp => "input-overflow",
            Self::Shutdown => "shutdown",
        }
    }

    /// the close frame for the browser; none when the browser is the one
    /// that left. reasons stay under the 123 bytes a close frame carries.
    fn close(&self) -> Option<CloseFrame> {
        let (code, reason): (u16, String) = match self {
            Self::Closed | Self::Stalled => return None,
            Self::Exited(reason) => (code::EXITED, clip(reason)),
            Self::Gone => (code::GONE, "the terminal is gone".into()),
            Self::Unreachable(why) => (
                code::UNREACHABLE,
                clip(&format!("the host is not answering: {why}")),
            ),
            Self::Refused => (code::REFUSED, "the host refused boxbox's credential".into()),
            Self::InputBackedUp => (
                code::INPUT_BACKED_UP,
                "input backed up; the terminal is not reading it".into(),
            ),
            Self::Shutdown => (code::STOPPING, "the server is stopping".into()),
        };
        Some(CloseFrame {
            code,
            reason: Utf8Bytes::from(reason),
        })
    }
}

fn clip(text: &str) -> String {
    let mut end = text.len().min(120);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// why the relay let go of the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cause {
    Dropped,
    Stalled,
    Overflow,
}

impl Cause {
    fn label(self) -> &'static str {
        match self {
            Self::Dropped => "dropped",
            Self::Stalled => "stalled",
            Self::Overflow => "overflow",
        }
    }
}

/// how one connection to the host ended.
#[derive(Debug)]
enum Session {
    Lost(Cause, String),
    Exited(String),
    Gone,
    /// the browser's side of the relay is gone.
    BrowserGone,
}

/// what the connection being dialled is for, for its log line and row.
#[derive(Debug, Clone, Copy)]
enum Dial {
    Open { since: Instant, resume: bool },
    Redial { since: Instant, cause: Cause },
}

#[derive(Debug, Default)]
struct Counters {
    down: AtomicU64,
    up: AtomicU64,
    redials: AtomicU64,
    overflows: AtomicU64,
}

impl Counters {
    fn add(counter: &AtomicU64, n: usize) {
        counter.fetch_add(u64::try_from(n).unwrap_or(u64::MAX), Ordering::Relaxed);
    }
}

fn millis(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl Relay {
    /// runs the relay until the browser leaves, the terminal ends, the
    /// host is lost for good or the server stops. `cursor` is the
    /// browser's (`None`: replay everything retained).
    pub async fn run(self, browser: WebSocket, cursor: Option<i64>) {
        let started = Instant::now();
        let counters = Counters::default();
        let (mut to_browser, from_browser) = browser.split();
        let (down, down_drain) = pump::<Message>(CAP, FRAMES);
        let (up, up_drain) = pump::<tungstenite::Utf8Bytes>(CAP, FRAMES);

        let end = {
            let writer = write_browser(&mut to_browser, down_drain);
            let reader = read_browser(from_browser, &up, &counters);
            let host = self.follow(cursor, started, &down, up_drain, &counters);
            tokio::pin!(writer, reader, host);
            let end = tokio::select! {
                end = &mut host => end,
                end = &mut reader => end,
                _ = &mut writer => End::Closed,
                () = self.shutdown.cancelled() => End::Shutdown,
            };
            if let Some(close) = end.close() {
                // the last output is queued ahead of the close; the writer sends both
                let flushed = timeout(CLOSE_GRACE, async {
                    if down.push(Message::Close(Some(close)), 0).await.is_ok() {
                        let _ = (&mut writer).await;
                    }
                })
                .await;
                if flushed.is_err() {
                    debug!(relay = %self.id, "the browser did not take the close in time");
                }
            }
            end
        };
        // flushes a close the browser sent, whose reply tungstenite queued
        let _ = timeout(CLOSE_GRACE, to_browser.close()).await;

        let down_bytes = counters.down.load(Ordering::Relaxed);
        let up_bytes = counters.up.load(Ordering::Relaxed);
        let redials = counters.redials.load(Ordering::Relaxed);
        let overflows = counters.overflows.load(Ordering::Relaxed);
        info!(
            relay = %self.id,
            host = %self.target.source.name(),
            pty = %self.target.pty,
            end = end.label(),
            down_bytes,
            up_bytes,
            redials,
            overflows,
            lived_ms = millis(started),
            "terminal relay ended"
        );
        emit(
            &self.telemetry,
            &self.stamp,
            Row::new("term.bytes")
                .ms(millis(started))
                .prop("down", down_bytes)
                .prop("up", up_bytes)
                .prop("redials", redials)
                .prop("overflows", overflows)
                .prop("end", end.label()),
        );
    }

    /// the host's side: dials, relays until the connection ends, and
    /// redials with the cursor until the terminal ends or the host is lost
    /// for `GIVE_UP`.
    async fn follow(
        &self,
        cursor: Option<i64>,
        opened: Instant,
        down: &Feed<Message>,
        mut up: Drain<tungstenite::Utf8Bytes>,
        counters: &Counters,
    ) -> End {
        let mut at = Position::new(cursor);
        let mut dial = Dial::Open {
            since: opened,
            resume: cursor.is_some(),
        };
        let mut backoff = Backoff::new(REDIAL_FLOOR, REDIAL_CAP);
        loop {
            let from = at.resume_from();
            at.dial();
            if let Dial::Redial { .. } = dial {
                let frame = protocol::replay_frame(from);
                let bytes = frame.len();
                if down
                    .push(Message::Binary(Bytes::from(frame)), bytes)
                    .await
                    .is_err()
                {
                    return End::Closed;
                }
            }
            let socket = match self
                .dialer
                .dial(&self.target.source, &self.target.pty, from)
                .await
            {
                Ok(socket) => socket,
                Err(e) => {
                    if let Some(end) = self.dial_failed(dial, &e) {
                        return end;
                    }
                    sleep(backoff.next_delay()).await;
                    continue;
                }
            };
            let (cause, why) = match self
                .session(socket, &mut at, dial, down, &mut up, counters)
                .await
            {
                Session::Exited(reason) => return End::Exited(reason),
                Session::Gone => return End::Gone,
                Session::BrowserGone => return End::Closed,
                Session::Lost(cause, why) => (cause, why),
            };
            warn!(
                relay = %self.id,
                host = %self.target.source.name(),
                pty = %self.target.pty,
                cause = cause.label(),
                why = %why,
                cursor = at.resume_from().unwrap_or(-1),
                "terminal lost its host; redialling from the cursor"
            );
            counters.redials.fetch_add(1, Ordering::Relaxed);
            let since = Instant::now();
            if at.live() {
                backoff.reset();
            }
            if cause == Cause::Overflow {
                counters.overflows.fetch_add(1, Ordering::Relaxed);
                if down.drained_to(LOW_WATER).await.is_err() {
                    return End::Closed;
                }
            } else {
                sleep(backoff.next_delay()).await;
            }
            dial = Dial::Redial { since, cause };
        }
    }

    /// what a failed dial means: the end of the relay, or `None` to try again.
    fn dial_failed(&self, dial: Dial, error: &DialError) -> Option<End> {
        let end = match error {
            DialError::NotFound => End::Gone,
            DialError::Refused => End::Refused,
            DialError::Unreachable(why) => match dial {
                Dial::Redial { since, .. } if since.elapsed() < GIVE_UP => {
                    debug!(relay = %self.id, why = %why, "redial failed; trying again");
                    return None;
                }
                _ => End::Unreachable(why.clone()),
            },
        };
        let row = match dial {
            Dial::Open { since, resume } => Row::new("term.open")
                .ms(millis(since))
                .prop("resume", u8::from(resume)),
            Dial::Redial { since, cause } => Row::new("term.reconnect")
                .ms(millis(since))
                .prop("cause", cause.label()),
        };
        warn!(
            relay = %self.id,
            host = %self.target.source.name(),
            pty = %self.target.pty,
            error = %error,
            "terminal dial failed"
        );
        emit(
            &self.telemetry,
            &self.stamp,
            row.ok(false).prop("error", error.to_string()),
        );
        Some(end)
    }

    /// one connection to the host, until it ends.
    async fn session(
        &self,
        socket: Socket,
        at: &mut Position,
        dial: Dial,
        down: &Feed<Message>,
        up: &mut Drain<tungstenite::Utf8Bytes>,
        counters: &Counters,
    ) -> Session {
        let (mut sink, mut stream) = socket.split();
        let reading = async {
            let mut deadline = tokio::time::Instant::now() + SILENCE;
            loop {
                let frame = tokio::select! {
                    frame = stream.next() => frame,
                    () = sleep_until(deadline) => {
                        return Session::Lost(Cause::Stalled, format!("no bytes for {}s", SILENCE.as_secs()));
                    }
                };
                deadline = tokio::time::Instant::now() + SILENCE;
                match frame {
                    Some(Ok(HostMessage::Text(text))) => {
                        let units = protocol::utf16_len(&text);
                        let bytes = text.len();
                        // valid utf-8 already; this re-wraps the same buffer
                        let Ok(text) = Utf8Bytes::try_from(Bytes::from(text)) else {
                            continue;
                        };
                        if at.live() {
                            if down.try_push(Message::Text(text), bytes).is_err() {
                                return Session::Lost(
                                    Cause::Overflow,
                                    format!("{} kb queued for the browser", down.queued() / 1024),
                                );
                            }
                        } else if down.push(Message::Text(text), bytes).await.is_err() {
                            return Session::BrowserGone;
                        }
                        at.output(units);
                        Counters::add(&counters.down, bytes);
                    }
                    Some(Ok(HostMessage::Binary(data))) => match protocol::upstream(&data) {
                        Upstream::Meta { cursor } => {
                            let settled = at.meta(cursor);
                            let bytes = data.len();
                            if down.push(Message::Binary(data), bytes).await.is_err() {
                                return Session::BrowserGone;
                            }
                            Counters::add(&counters.down, bytes);
                            self.settled(dial, settled, cursor);
                        }
                        Upstream::Unknown => {
                            debug!(relay = %self.id, bytes = data.len(), "a binary frame the contract does not declare; dropped");
                        }
                    },
                    Some(Ok(HostMessage::Close(frame))) => return closed_by_host(frame),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Session::Lost(Cause::Dropped, plain(&e)),
                    None => {
                        return Session::Lost(
                            Cause::Dropped,
                            "the connection ended without a close".into(),
                        );
                    }
                }
            }
        };
        let writing = async {
            let start = tokio::time::Instant::now() + HEARTBEAT_EVERY;
            let mut beat = interval_at(start, HEARTBEAT_EVERY);
            beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                let sent = tokio::select! {
                    input = up.next() => {
                        let Some(frame) = input else { return Session::BrowserGone };
                        let (text, held) = frame.into_parts();
                        let sent = sink.send(HostMessage::Text(text)).await;
                        drop(held);
                        sent
                    }
                    _ = beat.tick() => sink.send(HostMessage::Ping(Bytes::new())).await,
                };
                if let Err(e) = sent {
                    return Session::Lost(Cause::Dropped, plain(&e));
                }
            }
        };
        tokio::select! {
            session = reading => session,
            session = writing => session,
        }
    }

    /// a connection's replay is over: one log line and one row.
    fn settled(&self, dial: Dial, settled: Settled, cursor: i64) {
        let (message, row, since) = match dial {
            Dial::Open { since, resume } => (
                "terminal attached",
                Row::new("term.open").prop("resume", u8::from(resume)),
                since,
            ),
            Dial::Redial { since, cause } => (
                "terminal redialled",
                Row::new("term.reconnect").prop("cause", cause.label()),
                since,
            ),
        };
        info!(
            relay = %self.id,
            host = %self.target.source.name(),
            pty = %self.target.pty,
            cursor,
            replayed = settled.replayed,
            dropped = settled.dropped,
            ms = millis(since),
            "{message}"
        );
        emit(
            &self.telemetry,
            &self.stamp,
            row.ok(true)
                .ms(millis(since))
                .prop("replayed", settled.replayed)
                .prop("dropped", settled.dropped),
        );
    }
}

/// what the host's close frame means. cmx2 closes with 1000 when the
/// shell exits and 1011 when the terminal is gone; anything else, or a
/// close with no frame, is a lost connection worth redialling.
fn closed_by_host(frame: Option<tungstenite::protocol::CloseFrame>) -> Session {
    let Some(frame) = frame else {
        return Session::Lost(Cause::Dropped, "the host closed the connection".into());
    };
    let code = u16::from(frame.code);
    match code {
        1000 => Session::Exited(if frame.reason.is_empty() {
            "the terminal exited".into()
        } else {
            frame.reason.as_str().to_owned()
        }),
        1011 => Session::Gone,
        _ => Session::Lost(
            Cause::Dropped,
            format!(
                "the host closed the connection ({code} {})",
                frame.reason.as_str()
            ),
        ),
    }
}

/// the browser's writer: output, the relay's own frames and heartbeats,
/// until the queue ends or a close has been sent.
async fn write_browser(
    to: &mut SplitSink<WebSocket, Message>,
    mut drain: Drain<Message>,
) -> Result<(), axum::Error> {
    let start = tokio::time::Instant::now() + HEARTBEAT_EVERY;
    let mut beat = interval_at(start, HEARTBEAT_EVERY);
    beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            frame = drain.next() => {
                let Some(frame) = frame else { return Ok(()) };
                let (message, held) = frame.into_parts();
                let closing = matches!(message, Message::Close(_));
                to.send(message).await?;
                drop(held);
                if closing {
                    return Ok(());
                }
            }
            _ = beat.tick() => to.send(Message::Binary(Bytes::from_static(&protocol::HEARTBEAT))).await?,
        }
    }
}

/// the browser's reader: typed input into the up pump. binary frames are
/// the browser's heartbeats; they count as a sign of life and go no further.
async fn read_browser(
    mut from: SplitStream<WebSocket>,
    up: &Feed<tungstenite::Utf8Bytes>,
    counters: &Counters,
) -> End {
    let mut deadline = tokio::time::Instant::now() + SILENCE;
    loop {
        let message = tokio::select! {
            message = from.next() => message,
            () = sleep_until(deadline) => return End::Stalled,
        };
        deadline = tokio::time::Instant::now() + SILENCE;
        match message {
            Some(Ok(Message::Text(text))) if !text.is_empty() => {
                let bytes = text.len();
                let Ok(text) = tungstenite::Utf8Bytes::try_from(Bytes::from(text)) else {
                    continue;
                };
                if up.try_push(text, bytes).is_err() {
                    return End::InputBackedUp;
                }
                Counters::add(&counters.up, bytes);
            }
            Some(Ok(Message::Close(_)) | Err(_)) | None => return End::Closed,
            Some(Ok(_)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_end_the_browser_hears_about_has_a_short_reason() {
        let ends = [
            End::Exited("the terminal exited".into()),
            End::Gone,
            End::Unreachable("x".repeat(400)),
            End::Refused,
            End::InputBackedUp,
            End::Shutdown,
        ];
        for end in ends {
            let close = end.close().unwrap();
            assert!(close.reason.len() <= 123, "{end:?}");
            assert!(close.code == 1000 || close.code == 1001 || (4000..5000).contains(&close.code));
        }
        assert!(End::Closed.close().is_none());
        assert!(End::Stalled.close().is_none());
    }

    #[test]
    fn a_clipped_reason_never_splits_a_character() {
        let reason = format!("{}─", "a".repeat(119));
        assert_eq!(clip(&reason), "a".repeat(119));
    }

    #[test]
    fn the_hosts_close_codes_decide_between_redial_and_end() {
        use tungstenite::protocol::CloseFrame as HostClose;
        let frame = |code: u16, reason: &str| {
            Some(HostClose {
                code: code.into(),
                reason: reason.into(),
            })
        };
        assert!(
            matches!(closed_by_host(frame(1000, "the terminal exited")), Session::Exited(r) if r == "the terminal exited")
        );
        assert!(matches!(
            closed_by_host(frame(1011, "no such terminal")),
            Session::Gone
        ));
        assert!(matches!(
            closed_by_host(frame(1001, "")),
            Session::Lost(Cause::Dropped, _)
        ));
        assert!(matches!(
            closed_by_host(None),
            Session::Lost(Cause::Dropped, _)
        ));
    }
}
