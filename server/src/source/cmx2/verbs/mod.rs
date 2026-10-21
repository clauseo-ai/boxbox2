//! contract 1's daemon calls, on the cmx2 source (`Cmx2Raw`): each file
//! holds the calls one handler file made inline before the seam, moved
//! whole, headers and caps included. a handler finds the source through
//! `http::agents::cmx2`, which checks the capability first.

pub mod asks;
pub mod compose;
pub mod history;
pub mod hosts;
pub mod pty;
pub mod read;
pub mod refs;
pub mod review;
pub mod session;
pub mod threads;
pub mod transcript;
pub mod typed;
