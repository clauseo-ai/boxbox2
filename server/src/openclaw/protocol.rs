//! the gateway protocol's types, generated at build time from the vendored
//! schema (`server/build/openclaw.rs`, `docs/openclaw.md` 2.3).

#[allow(
    clippy::all,
    clippy::pedantic,
    missing_debug_implementations,
    dead_code,
    reason = "generated from the vendored schema; each phase of the source uses the types it needs"
)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/openclaw.rs"));
}

pub use generated::*;
