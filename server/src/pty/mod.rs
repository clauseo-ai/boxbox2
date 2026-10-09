//! terminals (architecture: terminals). the rest routes read a host's
//! `/pty` api through the server behind the gate; `connect` relays the
//! host's pty websocket to the browser, one relay task per open terminal,
//! with a bounded pump each way. `docs/terminal.md` is the whole story:
//! the wire, the caps, the close codes and what the pane does with them.

mod dial;
pub mod protocol;
mod pump;
mod relay;
pub mod routes;
mod telemetry;

use tokio_util::task::TaskTracker;

pub use dial::TlsSetupError;

/// what the terminal routes share: the dialler with its tls settings, and
/// the relays, tracked so shutdown can wait for them to close.
#[derive(Debug)]
pub struct Terminals {
    dialer: dial::Dialer,
    relays: TaskTracker,
}

impl Terminals {
    /// # Errors
    /// the tls settings for `wss://` hosts did not build.
    pub fn new() -> Result<Self, TlsSetupError> {
        Ok(Self {
            dialer: dial::Dialer::new()?,
            relays: TaskTracker::new(),
        })
    }

    /// relays open now.
    #[must_use]
    pub fn open(&self) -> usize {
        self.relays.len()
    }

    /// waits for every relay to finish. each ends on the shutdown token,
    /// telling its browser the server is stopping.
    pub async fn drained(&self) {
        self.relays.close();
        self.relays.wait().await;
    }
}
