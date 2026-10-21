//! cmx2's wire contract, generated at build time from
//! `vendor/cmx2/openapi.json` (see `build/cmx2.rs`).

#[allow(
    clippy::all,
    clippy::pedantic,
    missing_debug_implementations,
    dead_code,
    reason = "generated from the vendored openapi document; milestones use the contract route by route"
)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/cmx2.rs"));
}

pub use generated::*;

use serde::Deserialize;
use serde_json::value::RawValue;

/// one field of a payload's `properties`, read in a single pass over the
/// payload: reading the properties first and the field out of them scans
/// the payload twice, and a part is megabytes.
///
/// # Errors
/// the payload has no `properties`, or they lack the field.
pub fn property<'a, T: Deserialize<'a>>(payload: &'a RawValue) -> Result<T, serde_json::Error> {
    #[derive(Deserialize)]
    struct Under<T> {
        properties: T,
    }
    serde_json::from_str::<Under<T>>(payload.get()).map(|under| under.properties)
}

/// one `/global/event` frame, decoded.
#[derive(Debug)]
pub struct Decoded {
    /// the directory the event belongs to; absent on server events.
    pub directory: Option<String>,
    pub event: Event,
    /// the payload exactly as the daemon wrote it. daemon objects inside it
    /// (a message's info, a part) are passed to clients from here, never
    /// re-serialized from `event`, so their bytes and key order survive.
    pub payload: Box<serde_json::value::RawValue>,
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("the frame is not a GlobalFrame: {0}")]
    Envelope(serde_json::Error),
    #[error("the payload has no `type`: {0}")]
    Type(serde_json::Error),
    #[error("\"{0}\" is not an event type this contract declares")]
    UnknownType(String),
    #[error("{kind}: {source}")]
    Payload {
        kind: &'static str,
        source: serde_json::Error,
    },
}

/// decodes one frame's data: the envelope, then the payload's `type`, then
/// exactly that variant of the generated union.
///
/// # Errors
/// the frame does not match the vendored contract; the error names the
/// event type and the field.
pub fn decode_frame(data: &str) -> Result<Decoded, DecodeError> {
    let frame: GlobalFrame<'_> = serde_json::from_str(data).map_err(DecodeError::Envelope)?;
    let payload = frame.payload.get();
    let tag: PayloadType<'_> = serde_json::from_str(payload).map_err(DecodeError::Type)?;
    let kind = EventKind::from_wire(&tag.name)
        .ok_or_else(|| DecodeError::UnknownType(tag.name.into_owned()))?;
    let event = Event::decode(kind, payload).map_err(|source| DecodeError::Payload {
        kind: kind.as_str(),
        source,
    })?;
    Ok(Decoded {
        directory: frame.directory.map(std::borrow::Cow::into_owned),
        event,
        payload: frame.payload.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_declared_kind_round_trips_its_wire_name() {
        for kind in EventKind::ALL {
            assert_eq!(EventKind::from_wire(kind.as_str()), Some(kind));
        }
        assert_eq!(EventKind::from_wire("session.imaginary"), None);
    }

    #[test]
    fn decodes_a_server_event_and_a_scoped_event() {
        let connected = r#"{"payload":{"id":"evt_1","type":"server.connected","properties":{"version":"0.0.0-m5"}}}"#;
        let decoded = decode_frame(connected).unwrap();
        assert_eq!(decoded.event.kind(), EventKind::ServerConnected);
        assert_eq!(decoded.event.id(), "evt_1");
        assert!(decoded.directory.is_none());

        let delta = r#"{"directory":"/w","project":"p","payload":{"id":"evt_2","type":"message.part.delta",
            "properties":{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"hi","offset":0}}}"#;
        let decoded = decode_frame(delta).unwrap();
        assert_eq!(decoded.directory.as_deref(), Some("/w"));
        let Event::MessagePartDelta(event) = decoded.event else {
            panic!("wrong variant")
        };
        assert_eq!(event.properties.delta, "hi");
        assert_eq!(event.properties.offset, 0);
    }

    #[test]
    fn a_malformed_payload_names_its_type_and_field() {
        let missing =
            r#"{"payload":{"id":"e","type":"message.part.delta","properties":{"sessionID":"s"}}}"#;
        let error = decode_frame(missing).unwrap_err().to_string();
        assert!(
            error.starts_with("message.part.delta: missing field"),
            "{error}"
        );

        let unknown = r#"{"payload":{"id":"e","type":"session.imaginary","properties":{}}}"#;
        assert!(
            matches!(decode_frame(unknown), Err(DecodeError::UnknownType(t)) if t == "session.imaginary")
        );
        assert!(matches!(decode_frame("[]"), Err(DecodeError::Envelope(_))));
    }

    #[test]
    fn an_older_daemons_compaction_without_cold_still_decodes() {
        // cmx2 0.8.8 sends session.compacted without `cold`, which 0.8.13 added (build/cmx2.rs, ADDED_SINCE_OLDEST)
        let props = r#""sessionID":"s","trigger":"auto","tokensBefore":9,"tokensAfter":3,"durationMs":1,"waitedMs":0,"summaryMs":1,"summaryChars":4,"prefire":false,"tailFrom":0,"cleared":0,"cacheRead":0,"cacheWrite":0,"input":0,"output":0,"cost":0,"cacheReadPct":0"#;
        let old = format!(
            r#"{{"payload":{{"id":"e","type":"session.compacted","properties":{{{props}}}}}}}"#
        );
        let Event::SessionCompacted(event) = decode_frame(&old).unwrap().event else {
            panic!("wrong variant")
        };
        assert_eq!(event.properties.cold, None);
        let new = old.replace(r#""prefire":false"#, r#""prefire":false,"cold":true"#);
        let Event::SessionCompacted(event) = decode_frame(&new).unwrap().event else {
            panic!("wrong variant")
        };
        assert_eq!(event.properties.cold, Some(true));
    }

    #[test]
    fn a_type_field_cannot_hold_another_variants_name() {
        // decoded as heartbeat by dispatch, the payload's own `type` must agree
        let lying = r#"{"payload":{"id":"e","type":"server.heartbeat","properties":{}}}"#;
        assert!(decode_frame(lying).is_ok());
        let result = Event::decode(
            EventKind::ServerConnected,
            r#"{"id":"e","type":"server.heartbeat","properties":{"version":"1"}}"#,
        );
        assert!(
            result.is_err(),
            "a one-value enum guards each variant's type"
        );
    }
}
