//! per-device rate and dedupe.
//!
//! **rate**: each device has a bucket of four pushes that refills one
//! every 15 s. a burst (three threads finishing together) goes out at
//! once; a storm is paced so the push services never throttle the
//! subscription. nothing over the rate is lost: it waits in the device's
//! hold, one entry per thread tag, and a newer notice for the same thread
//! replaces the waiting one, exactly as the banner would.
//!
//! **dedupe**: a notice id reaches a device once. a reconnect that raises
//! the same ask again, or the fleet noticing twice, never buzzes twice.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use tokio::time::Instant;

pub const BURST: u32 = 4;
pub const REFILL: Duration = Duration::from_secs(15);
/// threads waiting per device; past this the oldest waiting one is dropped.
pub const MAX_HELD: usize = 16;
/// a notice id is remembered this long...
pub const REMEMBER_FOR: Duration = Duration::from_secs(30 * 60);
/// ...and at most this many (device, id) pairs are remembered at once.
pub const MAX_REMEMBERED: usize = 4096;

#[derive(Debug, Clone)]
pub struct Bucket {
    tokens: u32,
    refilled_at: Instant,
}

impl Bucket {
    #[must_use]
    pub fn full(now: Instant) -> Self {
        Self {
            tokens: BURST,
            refilled_at: now,
        }
    }

    /// takes a token if one is there.
    pub fn take(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.tokens == 0 {
            return false;
        }
        self.tokens -= 1;
        true
    }

    /// when the next token arrives; `now` if one is already there.
    #[must_use]
    pub fn next_token(&self, now: Instant) -> Instant {
        let mut probe = self.clone();
        probe.refill(now);
        if probe.tokens > 0 {
            now
        } else {
            probe.refilled_at + REFILL
        }
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.refilled_at);
        let gained = u32::try_from(elapsed.as_millis() / REFILL.as_millis()).unwrap_or(u32::MAX);
        if gained == 0 {
            return;
        }
        self.tokens = self.tokens.saturating_add(gained).min(BURST);
        self.refilled_at = if self.tokens == BURST {
            now
        } else {
            self.refilled_at + REFILL * gained
        };
    }
}

/// what waits for a token: the newest per thread tag, in arrival order.
#[derive(Debug)]
pub struct Hold<T> {
    waiting: VecDeque<(String, T)>,
}

impl<T> Default for Hold<T> {
    fn default() -> Self {
        Self {
            waiting: VecDeque::new(),
        }
    }
}

impl<T> Hold<T> {
    /// queues `item` under `tag`, replacing what waited under it; returns
    /// what fell out (the replaced item, or the oldest when full).
    pub fn put(&mut self, tag: &str, item: T) -> Option<T> {
        if let Some(index) = self.waiting.iter().position(|(t, _)| t == tag) {
            let (_, replaced) = self.waiting.remove(index)?;
            self.waiting.push_back((tag.to_owned(), item));
            return Some(replaced);
        }
        let dropped = if self.waiting.len() >= MAX_HELD {
            self.waiting.pop_front().map(|(_, item)| item)
        } else {
            None
        };
        self.waiting.push_back((tag.to_owned(), item));
        dropped
    }

    pub fn next(&mut self) -> Option<T> {
        self.waiting.pop_front().map(|(_, item)| item)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }
}

/// the (device, notice id) pairs sent recently.
#[derive(Debug, Default)]
pub struct Recent {
    order: VecDeque<(Instant, String)>,
    seen: HashSet<String>,
}

impl Recent {
    /// records the pair; false if it was already sent inside the window.
    pub fn first_time(&mut self, device: &str, id: &str, now: Instant) -> bool {
        self.expire(now);
        let key = format!("{device}\u{0}{id}");
        if self.seen.contains(&key) {
            return false;
        }
        if self.order.len() >= MAX_REMEMBERED
            && let Some((_, oldest)) = self.order.pop_front()
        {
            self.seen.remove(&oldest);
        }
        self.seen.insert(key.clone());
        self.order.push_back((now, key));
        true
    }

    fn expire(&mut self, now: Instant) {
        while let Some((at, _)) = self.order.front() {
            if now.saturating_duration_since(*at) <= REMEMBER_FOR {
                break;
            }
            if let Some((_, key)) = self.order.pop_front() {
                self.seen.remove(&key);
            }
        }
    }
}

/// a device's rate state.
#[derive(Debug)]
pub struct Limits<T> {
    pub bucket: Bucket,
    pub hold: Hold<T>,
}

/// every device's limits, created on first use and dropped with the
/// subscription.
#[derive(Debug)]
pub struct Rates<T> {
    devices: HashMap<String, Limits<T>>,
}

impl<T> Default for Rates<T> {
    fn default() -> Self {
        Self {
            devices: HashMap::new(),
        }
    }
}

impl<T> Rates<T> {
    pub fn of(&mut self, device: &str, now: Instant) -> &mut Limits<T> {
        self.devices
            .entry(device.to_owned())
            .or_insert_with(|| Limits {
                bucket: Bucket::full(now),
                hold: Hold::default(),
            })
    }

    pub fn forget(&mut self, device: &str) {
        self.devices.remove(device);
    }

    /// the soonest moment a waiting item can go out, if anything waits.
    #[must_use]
    pub fn next_release(&self, now: Instant) -> Option<Instant> {
        self.devices
            .values()
            .filter(|limits| !limits.hold.is_empty())
            .map(|limits| limits.bucket.next_token(now))
            .min()
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut Limits<T>)> {
        self.devices.iter_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_of_four_goes_then_one_every_fifteen_seconds() {
        let start = Instant::now();
        let mut bucket = Bucket::full(start);
        assert!((0..BURST).all(|_| bucket.take(start)));
        assert!(!bucket.take(start));
        assert_eq!(bucket.next_token(start), start + REFILL);
        assert!(!bucket.take(start + REFILL - Duration::from_millis(1)));
        assert!(bucket.take(start + REFILL));
        assert!(!bucket.take(start + REFILL));
    }

    #[test]
    fn an_idle_bucket_refills_to_the_burst_and_no_further() {
        let start = Instant::now();
        let mut bucket = Bucket::full(start);
        assert!((0..BURST).all(|_| bucket.take(start)));
        let later = start + REFILL * 100;
        assert_eq!((0..10).filter(|_| bucket.take(later)).count(), 4);
    }

    #[test]
    fn a_newer_notice_for_a_thread_replaces_the_waiting_one() {
        let mut hold = Hold::default();
        assert_eq!(hold.put("thread:a", 1), None);
        assert_eq!(hold.put("thread:b", 2), None);
        assert_eq!(hold.put("thread:a", 3), Some(1));
        assert_eq!(hold.next(), Some(2));
        assert_eq!(hold.next(), Some(3));
        assert_eq!(hold.next(), None);
    }

    #[test]
    fn a_full_hold_drops_its_oldest() {
        let mut hold = Hold::default();
        for n in 0..MAX_HELD {
            assert_eq!(hold.put(&format!("t{n}"), n), None);
        }
        assert_eq!(hold.put("one more", 99), Some(0));
    }

    #[test]
    fn a_notice_reaches_each_device_once_within_the_window() {
        let start = Instant::now();
        let mut recent = Recent::default();
        assert!(recent.first_time("phone", "ask:q1", start));
        assert!(!recent.first_time("phone", "ask:q1", start + Duration::from_secs(60)));
        assert!(recent.first_time("mac", "ask:q1", start));
        assert!(recent.first_time(
            "phone",
            "ask:q1",
            start + REMEMBER_FOR + Duration::from_secs(1)
        ));
    }

    #[test]
    fn remembered_pairs_are_capped() {
        let start = Instant::now();
        let mut recent = Recent::default();
        for n in 0..=MAX_REMEMBERED {
            recent.first_time("phone", &n.to_string(), start);
        }
        assert_eq!(recent.seen.len(), MAX_REMEMBERED);
        assert!(
            recent.first_time("phone", "0", start),
            "the oldest was forgotten"
        );
    }
}
