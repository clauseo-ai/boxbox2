//! a pump: one direction of a relay, a queue bounded by bytes and by
//! frames (architecture: memory caps, 256 kb each way).
//!
//! bytes are counted with a semaphore whose permits are the budget. a
//! frame holds its permits until the socket has taken it, so the budget
//! covers the frame being written as well as the ones waiting behind it.
//! a producer either takes room now (`try_push`, for live output: no room
//! means the other end has fallen behind) or waits for it (`push`, for a
//! replay, whose size cmx2 already bounds).

use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

/// the queue is full; the frame was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overflow;

/// the consuming side is gone; nothing will take the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Closed;

/// a frame, and the share of the budget it holds until it is dropped.
#[derive(Debug)]
pub struct Frame<M> {
    pub message: M,
    held: OwnedSemaphorePermit,
}

impl<M> Frame<M> {
    /// the message, and the permit to drop once the socket has taken it.
    pub fn into_parts(self) -> (M, Held) {
        (self.message, Held(self.held))
    }
}

/// a frame's share of the budget, returned when dropped.
#[derive(Debug)]
pub struct Held(#[allow(dead_code, reason = "held for its drop")] OwnedSemaphorePermit);

/// the producing side.
#[derive(Debug)]
pub struct Feed<M> {
    frames: mpsc::Sender<Frame<M>>,
    budget: Arc<Semaphore>,
    cap: usize,
}

/// the consuming side.
#[derive(Debug)]
pub struct Drain<M> {
    frames: mpsc::Receiver<Frame<M>>,
}

/// a pump of at most `cap` bytes and `frames` frames. a single frame
/// larger than `cap` never fits.
#[must_use]
pub fn pump<M>(cap: usize, frames: usize) -> (Feed<M>, Drain<M>) {
    let (sender, receiver) = mpsc::channel(frames);
    (
        Feed {
            frames: sender,
            budget: Arc::new(Semaphore::new(cap)),
            cap,
        },
        Drain { frames: receiver },
    )
}

impl<M> Feed<M> {
    /// queues the frame if it fits now.
    ///
    /// # Errors
    /// the bytes or the frame count are over the cap (or the drain is gone,
    /// which the caller learns on its next wait).
    pub fn try_push(&self, message: M, bytes: usize) -> Result<(), Overflow> {
        let permits = u32::try_from(bytes).map_err(|_| Overflow)?;
        let held = Arc::clone(&self.budget)
            .try_acquire_many_owned(permits)
            .map_err(|_| Overflow)?;
        self.frames
            .try_send(Frame { message, held })
            .map_err(|_| Overflow)
    }

    /// queues the frame once there is room for it.
    ///
    /// # Errors
    /// the drain is gone, or the frame is larger than the whole budget.
    pub async fn push(&self, message: M, bytes: usize) -> Result<(), Closed> {
        if bytes > self.cap {
            return Err(Closed);
        }
        let permits = u32::try_from(bytes).map_err(|_| Closed)?;
        let held = Arc::clone(&self.budget)
            .acquire_many_owned(permits)
            .await
            .map_err(|_| Closed)?;
        self.frames
            .send(Frame { message, held })
            .await
            .map_err(|_| Closed)
    }

    /// bytes queued or being written.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.cap.saturating_sub(self.budget.available_permits())
    }

    /// waits until at most `low` bytes are queued or being written.
    ///
    /// # Errors
    /// the drain is gone.
    pub async fn drained_to(&self, low: usize) -> Result<(), Closed> {
        let wanted = u32::try_from(self.cap.saturating_sub(low)).map_err(|_| Closed)?;
        // the semaphore is fair, so this waits behind nothing but the frames already queued
        let room = self.budget.acquire_many(wanted).await.map_err(|_| Closed)?;
        drop(room);
        if self.frames.is_closed() {
            Err(Closed)
        } else {
            Ok(())
        }
    }
}

impl<M> Drain<M> {
    /// the next frame, or `None` once every feed is gone and the queue is empty.
    pub async fn next(&mut self) -> Option<Frame<M>> {
        self.frames.recv().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn live_output_that_does_not_fit_is_refused_not_queued() {
        let (feed, mut drain) = pump::<&str>(10, 8);
        assert_eq!(feed.try_push("hello", 5), Ok(()));
        assert_eq!(feed.try_push("world", 5), Ok(()));
        assert_eq!(feed.try_push("!", 1), Err(Overflow), "the budget is spent");
        assert_eq!(feed.queued(), 10);
        let first = drain.next().await.unwrap();
        assert_eq!(first.message, "hello");
        assert_eq!(
            feed.queued(),
            10,
            "a frame holds its bytes until it is written"
        );
        drop(first);
        assert_eq!(feed.queued(), 5);
        assert_eq!(feed.try_push("!", 1), Ok(()));
    }

    #[tokio::test]
    async fn the_frame_count_is_a_cap_too() {
        let (feed, _drain) = pump::<u8>(1024, 2);
        assert_eq!(feed.try_push(1, 1), Ok(()));
        assert_eq!(feed.try_push(2, 1), Ok(()));
        assert_eq!(feed.try_push(3, 1), Err(Overflow));
    }

    #[tokio::test]
    async fn a_replay_waits_for_room_instead_of_overflowing() {
        let (feed, mut drain) = pump::<u32>(8, 8);
        feed.push(1, 8).await.unwrap();
        let waiting = tokio::spawn(async move {
            feed.push(2, 8).await.unwrap();
            feed
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(drain.next().await.unwrap());
        let feed = waiting.await.unwrap();
        assert_eq!(feed.queued(), 8);
        assert_eq!(drain.next().await.unwrap().message, 2);
    }

    #[tokio::test]
    async fn drained_to_waits_for_the_writer() {
        let (feed, mut drain) = pump::<u32>(100, 8);
        feed.try_push(1, 60).unwrap();
        feed.try_push(2, 30).unwrap();
        let feed = Arc::new(feed);
        let waiter = {
            let feed = Arc::clone(&feed);
            tokio::spawn(async move { feed.drained_to(25).await })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        drop(drain.next().await.unwrap());
        tokio::task::yield_now().await;
        assert!(
            !waiter.is_finished(),
            "30 bytes still queued is more than 25"
        );
        drop(drain.next().await.unwrap());
        assert_eq!(waiter.await.unwrap(), Ok(()));
    }

    #[tokio::test]
    async fn a_frame_larger_than_the_budget_never_fits() {
        let (feed, _drain) = pump::<u8>(4, 8);
        assert_eq!(feed.try_push(0, 5), Err(Overflow));
        assert_eq!(feed.push(0, 5).await, Err(Closed));
    }
}
