//! the board's channel on the server (`docs/board.md`): who the board is
//! and where, the app windows on its mac, and the routes (`routes.rs`).
//! built only when `[board]` is in `boxbox.toml`; without it nothing here
//! exists and no route answers but 404.
//!
//! presence is one board at a time: its device id, the addresses of its
//! mac (what its daemon listed, and what the server saw it connect from),
//! the digits it seats, and the stream it listens on. a new stream takes
//! over and the old one is told it was replaced. `Act::Gone` ends presence
//! at once; a stream that drops without it keeps presence for 20 s, a
//! timer that exists only during that grace, then ends it.
//!
//! app windows that asked for board frames (`/api/stream?board=1`) are held
//! here with their address and a small bounded channel. whether a window is
//! on the board's mac is worked out once when presence moves (one address
//! check a window), so a focus or a compose costs one flag a window.
//!
//! the state is small and every section is short and never awaits, so it
//! sits behind a mutex the way the send ledger does (`source/sends.rs`).

pub mod addr;
pub mod routes;
pub mod store;

use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use boxbox_board_wire::{AppFrame, Frame, Seat};
use bytes::Bytes;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::config::BoardConfig;
use crate::fleet::board::{AgentLight, Roster};
use crate::journal::sse_frame;
use crate::upstream::Upstreams;
use crate::wire::AgentStatus;

/// a board stream that dropped without `gone` stays present this long: a
/// mac that slept or a network that blinked comes back inside it.
pub const GRACE: Duration = Duration::from_secs(20);
/// frames waiting for one board stream (pins) or one app window (focus,
/// compose, digits); a reader this far behind loses the next one.
const FRAMES: usize = 16;

#[derive(Debug)]
pub struct Board {
    config: BoardConfig,
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    here: Option<Here>,
    /// presence's generation: each board stream gets the next.
    generation: u64,
    windows: Vec<Window>,
    next_window: u64,
}

#[derive(Debug)]
struct Here {
    generation: u64,
    device: String,
    addrs: Vec<IpAddr>,
    since: Instant,
    seats: Vec<Seat>,
    /// the stream it listens on; none during the grace.
    link: Option<Link>,
    /// the grace's timer, while it runs.
    grace: Option<CancellationToken>,
}

#[derive(Debug)]
struct Link {
    frames: mpsc::Sender<Bytes>,
    replaced: CancellationToken,
}

#[derive(Debug)]
struct Window {
    id: u64,
    addr: IpAddr,
    frames: mpsc::Sender<Bytes>,
    /// on the board's mac, as of the last presence change.
    here: bool,
}

/// a board stream's place: its generation, its frames, and the token fired
/// when another stream takes over.
#[derive(Debug)]
pub struct Joined {
    pub generation: u64,
    pub frames: mpsc::Receiver<Bytes>,
    pub replaced: CancellationToken,
}

/// why a board verb could not be carried out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("no board is connected")]
    NoBoard,
    #[error("no app window is open on the board's mac")]
    NoWindow,
    #[error("the board's stream is not reading")]
    Busy,
}

/// an app window's board frames; it leaves the board when dropped.
#[derive(Debug)]
pub struct WindowFeed {
    board: Arc<Board>,
    id: u64,
    pub frames: mpsc::Receiver<Bytes>,
}

impl Drop for WindowFeed {
    fn drop(&mut self) {
        self.board.lock().windows.retain(|w| w.id != self.id);
    }
}

impl Board {
    #[must_use]
    pub fn new(config: BoardConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            state: Mutex::new(State::default()),
        })
    }

    #[must_use]
    pub fn machines(&self) -> Option<Vec<String>> {
        self.config.machines.clone()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // a panic mid-section leaves plain data, still true enough to serve
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// a board stream opened from `observed` with its mac's `addrs`: it is
    /// the board now. the stream it replaces is told so.
    pub fn join(&self, device: &str, mut addrs: Vec<IpAddr>, observed: IpAddr) -> Joined {
        // a loopback address says nothing about the mac: behind a proxy that
        // sent no usable X-Forwarded-For every client resolves to it, and a
        // phone would match. a daemon on the server's own machine lists it itself.
        if !observed.is_loopback() && !addrs.contains(&observed) {
            addrs.push(observed);
        }
        let (frames, receiver) = mpsc::channel(FRAMES);
        let replaced = CancellationToken::new();
        let mut state = self.lock();
        state.generation += 1;
        let generation = state.generation;
        let old = state.here.take();
        let seats = match old {
            Some(old) => {
                end_link(&old);
                // the same board coming back keeps its digits until it says otherwise
                if old.device == device {
                    old.seats
                } else {
                    Vec::new()
                }
            }
            None => Vec::new(),
        };
        info!(generation, addrs = addrs.len(), "a board connected");
        debug!(?addrs, "the board's mac");
        state.here = Some(Here {
            generation,
            device: device.to_owned(),
            addrs,
            since: Instant::now(),
            seats,
            link: Some(Link {
                frames,
                replaced: replaced.clone(),
            }),
            grace: None,
        });
        state.moved();
        Joined {
            generation,
            frames: receiver,
            replaced,
        }
    }

    /// the stream of `generation` closed. if it was still the board's and
    /// did not say `gone`, presence waits out the grace.
    pub fn left(self: &Arc<Self>, generation: u64) {
        let mut state = self.lock();
        let Some(here) = state.here.as_mut().filter(|h| h.generation == generation) else {
            return;
        };
        if here.link.take().is_none() {
            return;
        }
        let grace = CancellationToken::new();
        here.grace = Some(grace.clone());
        info!(
            generation,
            grace_s = GRACE.as_secs(),
            "the board's stream dropped; it stays present through the grace"
        );
        let board = Arc::clone(self);
        tokio::spawn(async move {
            tokio::select! {
                () = grace.cancelled() => {}
                () = tokio::time::sleep(GRACE) => board.expire(generation),
            }
        });
    }

    fn expire(&self, generation: u64) {
        let mut state = self.lock();
        if state
            .here
            .as_ref()
            .is_some_and(|h| h.generation == generation && h.link.is_none())
        {
            state.end("its stream did not come back");
        }
    }

    /// the board was unplugged (`Act::Gone`), said from `from`. a gone from
    /// an address that is not the board's mac is the mac it left, late, and
    /// changes nothing.
    pub fn gone(&self, from: IpAddr) {
        let mut state = self.lock();
        if state.here.as_ref().is_some_and(|h| h.addrs.contains(&from)) {
            state.end("it was unplugged");
        } else {
            debug!(%from, "a board's gone from a mac it is not on; ignored");
        }
    }

    /// the board's device id while one is present.
    #[must_use]
    pub fn device(&self) -> Option<String> {
        self.lock().here.as_ref().map(|h| h.device.clone())
    }

    /// the digits the board shows now, for the windows on its mac.
    ///
    /// # Errors
    /// no board is present.
    pub fn seats(&self, seats: Vec<Seat>) -> Result<(), Refused> {
        let mut state = self.lock();
        let here = state.here.as_mut().ok_or(Refused::NoBoard)?;
        here.seats = seats;
        let frame = app_frame(&AppFrame::Here {
            seats: here.seats.clone(),
        });
        state.relay(frame.as_ref());
        Ok(())
    }

    /// relays a focus or a compose to the windows on the board's mac.
    ///
    /// # Errors
    /// no board is present, or no window on its mac listens.
    pub fn relay(&self, frame: &AppFrame) -> Result<(), Refused> {
        let mut state = self.lock();
        if state.here.is_none() {
            return Err(Refused::NoBoard);
        }
        let frame = app_frame(frame);
        if state.relay(frame.as_ref()) == 0 {
            return Err(Refused::NoWindow);
        }
        Ok(())
    }

    /// sends the board's stream a frame (a pin).
    ///
    /// # Errors
    /// no board stream is open.
    pub fn to_board(&self, frame: &Frame) -> Result<(), Refused> {
        let state = self.lock();
        let link = state
            .here
            .as_ref()
            .and_then(|h| h.link.as_ref())
            .ok_or(Refused::NoBoard)?;
        let Some(frame) = encode(frame) else {
            return Err(Refused::NoBoard);
        };
        link.frames.try_send(frame).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => {
                warn!("the board's stream is not reading; a frame for it was dropped");
                Refused::Busy
            }
            // the stream is closing: it is about to leave presence
            mpsc::error::TrySendError::Closed(_) => Refused::NoBoard,
        })
    }

    /// an app window that asked for board frames, connecting from `addr`.
    /// on the board's mac while a board is here, it gets the digits at once.
    #[must_use]
    pub fn window(self: &Arc<Self>, addr: IpAddr) -> WindowFeed {
        let (frames, receiver) = mpsc::channel(FRAMES);
        let mut state = self.lock();
        state.next_window += 1;
        let id = state.next_window;
        let here = state.here.as_ref().filter(|h| h.addrs.contains(&addr));
        if let Some(here) = here {
            let seats = here.seats.clone();
            if let Some(frame) = app_frame(&AppFrame::Here { seats }) {
                let _ = frames.try_send(frame);
            }
        }
        let on = here.is_some();
        state.windows.push(Window {
            id,
            addr,
            frames,
            here: on,
        });
        WindowFeed {
            board: Arc::clone(self),
            id,
            frames: receiver,
        }
    }

    /// how many app windows sit on the board's mac now.
    #[cfg(test)]
    fn windows_here(&self) -> usize {
        self.lock().windows.iter().filter(|w| w.here).count()
    }
}

impl State {
    /// presence moved: each window learns whether it is on the board's mac,
    /// and the ones that changed sides hear so.
    fn moved(&mut self) {
        let here = self.here.as_ref();
        let arrived = here.and_then(|h| {
            app_frame(&AppFrame::Here {
                seats: h.seats.clone(),
            })
        });
        let left = app_frame(&AppFrame::Gone);
        for window in &mut self.windows {
            let on = here.is_some_and(|h| h.addrs.contains(&window.addr));
            let frame = match (window.here, on) {
                (_, true) => arrived.as_ref(),
                (true, false) => left.as_ref(),
                (false, false) => None,
            };
            window.here = on;
            if let Some(frame) = frame {
                send(window, frame.clone());
            }
        }
    }

    /// ends presence and tells the windows on the board's mac.
    fn end(&mut self, why: &'static str) {
        if let Some(here) = self.here.take() {
            // dropping the link ends its stream without `replaced`: nothing took over
            if let Some(grace) = &here.grace {
                grace.cancel();
            }
            info!(
                generation = here.generation,
                present_s = here.since.elapsed().as_secs(),
                why,
                "the board left"
            );
        }
        self.moved();
    }

    /// sends `frame` to every window on the board's mac; how many took it.
    fn relay(&mut self, frame: Option<&Bytes>) -> usize {
        let Some(frame) = frame else { return 0 };
        self.windows
            .iter()
            .filter(|w| w.here)
            .filter(|w| send(w, frame.clone()))
            .count()
    }
}

/// a presence that ended or was replaced: its stream closes after `replaced`
/// and its grace timer stops.
fn end_link(here: &Here) {
    if let Some(link) = &here.link {
        link.replaced.cancel();
    }
    if let Some(grace) = &here.grace {
        grace.cancel();
    }
}

fn send(window: &Window, frame: Bytes) -> bool {
    match window.frames.try_send(frame) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => {
            warn!(
                window = window.id,
                "an app window is not reading its board frames; one was dropped"
            );
            false
        }
        // the window's stream is closing; its feed leaves on drop
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    }
}

/// an id-less sse frame for an app window: outside the journal, no seq.
fn app_frame(frame: &AppFrame) -> Option<Bytes> {
    match serde_json::to_vec(frame) {
        Ok(json) => Some(sse_frame(None, &json)),
        Err(e) => {
            error!(error = %e, "a board frame for an app window did not serialize");
            None
        }
    }
}

/// a frame for the board's stream.
fn encode(frame: &Frame) -> Option<Bytes> {
    match serde_json::to_vec(frame) {
        Ok(json) => Some(sse_frame(None, &json)),
        Err(e) => {
            error!(error = %e, "a board frame did not serialize");
            None
        }
    }
}

/// the machine lights read every source's agents and its connection.
impl Roster for Upstreams {
    fn agents(&self) -> Vec<AgentLight> {
        let mut agents = Vec::new();
        for source in self.sources() {
            let status = source.connection_status().status;
            let up = matches!(status, AgentStatus::Ready | AgentStatus::Syncing);
            for facts in source.agents().borrow().iter() {
                agents.push(AgentLight {
                    key: facts.key.clone(),
                    machine: facts.label.machine.clone(),
                    up,
                });
            }
        }
        agents
    }
}

#[cfg(test)]
mod tests;
