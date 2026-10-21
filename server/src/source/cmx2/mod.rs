//! the cmx2 source: today's watcher, reconcile and tail reader
//! (`upstream/`), plus the translation of cmx2's events into `SourceEvent`.
//! one per `[[cmx2]]` (or `[[host]]`) connection; its agent is the
//! connection, keyed by the connection's name.

pub mod translate;
pub mod verbs;

use serde_json::value::RawValue;
use tracing::warn;

use crate::cmx2::Decoded;
use crate::source::SourceEvent;
pub use crate::upstream::source::Cmx2Source;

/// one decoded daemon frame as what the source sends the fleet: the event
/// and the payload contract 1 journals from. none for a type nothing
/// consumes; `Skipped` for a payload that lacks what it decoded with (with
/// a warning, the one skip the translation has), so the fleet knows
/// something changed that it could not read.
#[must_use]
pub fn from_frame(host: &str, decoded: Decoded) -> Option<(SourceEvent, Box<RawValue>)> {
    match translate::event(
        host,
        decoded.directory.as_deref(),
        &decoded.event,
        &decoded.payload,
    ) {
        Ok(Some(event)) => Some((event, decoded.payload)),
        Ok(None) => None,
        Err(error) => {
            warn!(host, kind = decoded.event.kind().as_str(), %error, "an event's payload lacks what it decoded with; skipped");
            Some((SourceEvent::Skipped, decoded.payload))
        }
    }
}
