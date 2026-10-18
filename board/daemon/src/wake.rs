//! when the main loop wakes next: the earliest of the deadlines that apply
//! now. pure, so the rule that keeps an idle daemon asleep has a test: no
//! board, no deadline at all; and a telemetry batch counts only while there
//! is a poster to take it (otherwise its deadline stays in the past and the
//! loop would spin).

/// the deadlines the loop knows, in monotonic ms.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Deadlines {
    /// a board is on the link.
    pub plugged: bool,
    /// the plug has a network session (its hello was acked and the session
    /// started), so a telemetry batch can go.
    pub has_net: bool,
    /// the hello's retry, while it is unanswered.
    pub hello: Option<u64>,
    /// the next `perf.board` sample, once acked.
    pub perf: Option<u64>,
    /// when the composed frame next changes on its own.
    pub frame: u64,
    /// the painter's next write: an animation step or the keepalive.
    pub paint: u64,
    /// the queued telemetry batch's flush.
    pub telemetry: Option<u64>,
}

/// the next wake, or `None` to sleep until a message.
#[must_use]
pub fn next(d: &Deadlines) -> Option<u64> {
    if !d.plugged {
        return None;
    }
    [
        d.hello,
        d.perf,
        Some(d.frame),
        Some(d.paint),
        d.telemetry.filter(|_| d.has_net),
    ]
    .into_iter()
    .flatten()
    .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_board_means_no_deadline_even_with_telemetry_queued() {
        let d = Deadlines {
            telemetry: Some(0),
            ..Deadlines::default()
        };
        assert_eq!(next(&d), None);
    }

    #[test]
    fn a_batch_without_a_poster_never_wakes_the_loop() {
        // the hello is unanswered, so no session exists: a batch due long
        // ago must not pull the wake into the past.
        let d = Deadlines {
            plugged: true,
            has_net: false,
            hello: Some(4_000),
            frame: u64::MAX,
            paint: 2_500,
            telemetry: Some(10),
            ..Deadlines::default()
        };
        assert_eq!(next(&d), Some(2_500));
        let with_net = Deadlines { has_net: true, ..d };
        assert_eq!(next(&with_net), Some(10));
    }
}
