//! reconnect delays: exponential, capped, with jitter so a fleet of
//! watchers that lost the same network does not redial in lockstep.

use std::time::Duration;

#[derive(Debug)]
pub struct Backoff {
    floor: Duration,
    cap: Duration,
    attempt: u32,
}

impl Backoff {
    #[must_use]
    pub fn new(floor: Duration, cap: Duration) -> Self {
        Self {
            floor,
            cap,
            attempt: 0,
        }
    }

    /// the next wait: the ceiling doubles per attempt up to the cap, and the
    /// wait falls uniformly in the upper half of it ("equal jitter"), so it
    /// never collapses to zero and never passes the cap.
    pub fn next_delay(&mut self) -> Duration {
        self.next_with(rand::random::<f64>())
    }

    /// `unit` is a uniform draw from `[0, 1)`; split out so tests pick it.
    fn next_with(&mut self, unit: f64) -> Duration {
        let ceiling = self
            .floor
            .saturating_mul(1 << self.attempt.min(16))
            .min(self.cap);
        self.attempt = self.attempt.saturating_add(1);
        let half = ceiling / 2;
        half + half.mul_f64(unit.clamp(0.0, 1.0))
    }

    /// a connection that held proves the host is back; start small again.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLOOR: Duration = Duration::from_millis(500);
    const CAP: Duration = Duration::from_secs(30);

    #[test]
    fn grows_by_doubling_until_the_cap() {
        let mut backoff = Backoff::new(FLOOR, CAP);
        let ceilings: Vec<u128> = (0..10)
            .map(|_| backoff.next_with(0.999_999).as_millis())
            .collect();
        assert_eq!(
            ceilings,
            [
                499, 999, 1999, 3999, 7999, 15999, 29999, 29999, 29999, 29999
            ]
        );
    }

    #[test]
    fn never_waits_less_than_half_the_ceiling() {
        let mut backoff = Backoff::new(FLOOR, CAP);
        assert_eq!(backoff.next_with(0.0), Duration::from_millis(250));
        assert_eq!(backoff.next_with(0.0), Duration::from_millis(500));
    }

    #[test]
    fn reset_starts_over() {
        let mut backoff = Backoff::new(FLOOR, CAP);
        for _ in 0..8 {
            backoff.next_delay();
        }
        backoff.reset();
        assert!(backoff.next_delay() <= FLOOR);
    }

    #[test]
    fn many_attempts_do_not_overflow() {
        let mut backoff = Backoff::new(FLOOR, CAP);
        for _ in 0..10_000 {
            assert!(backoff.next_delay() <= CAP);
        }
    }
}
