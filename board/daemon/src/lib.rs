//! boxbox-board, the board's daemon (`docs/board.md`). the pure modules
//! (the keypad's wire, the verb grammar, the scenes) take time as an input and
//! touch no device, so the tests and the trace harness drive them exactly.
//! the controller, the state and the painter are pure the same way; the
//! daemon around them (the keypad, the network, the microphone) is macos only.

#![forbid(unsafe_code)]

#[cfg(target_os = "macos")]
pub mod audio;
pub mod config;
pub mod controller;
#[cfg(target_os = "macos")]
pub mod daemon;
#[cfg(target_os = "macos")]
pub mod device;
#[cfg(target_os = "macos")]
pub mod install;
pub mod livery;
pub mod log;
#[cfg(target_os = "macos")]
pub mod net;
pub mod paint;
pub mod protocol;
pub mod render;
pub mod scenes;
pub mod sse;
pub mod state;
pub mod telemetry;
pub mod verbs;
pub mod vu;
pub mod wake;
